import { randomUUID } from 'node:crypto';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import compression from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import { Logger } from 'nestjs-pino';

import { ConfigService } from '@core/config/config.service';
import { HttpAppExceptionFilter } from '@core/errors/http-exception.filter';
import { EXCHANGES, QUEUES } from '@contracts/messaging/topology';
import { AppModule } from './app.module';
import { GatewayConfig } from './config/gateway.config';

/**
 * The only public HTTP surface. It owns no domain data: everything it serves
 * comes from a message to another service or from object storage.
 */
async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  await app.register(compression);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // 400 instead of silently dropping, so a client learns about its typo.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // One envelope for every failure, so a client branches on `code` rather
  // than on prose or on a bare status.
  app.useGlobalFilters(new HttpAppExceptionFilter());

  const configService = app.get<ConfigService<GatewayConfig>>(ConfigService);

  app.enableCors({
    origin: configService
      .get('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  await app.register(fastifyCookie, {
    secret: configService.get('COOKIE_SECRET'),
  });

  // The gateway is an HTTP surface that also *listens*: it subscribes to
  // `domain.events` so an RBAC change reaches its cache without a restart.
  //
  // The queue is per replica and non-durable — every gateway must receive the
  // notification, not one of them, and a message that arrived while a replica
  // was down is worthless to it, since it reloads the whole config at boot.
  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.RMQ,
      options: {
        urls: [configService.get('RABBITMQ_URL')],
        exchange: EXCHANGES.DOMAIN_EVENTS,
        exchangeType: 'topic',
        wildcards: true,
        queue: `${QUEUES.GATEWAY_EVENTS}.${process.env.HOSTNAME ?? randomUUID()}`,
        queueOptions: { durable: false, autoDelete: true, exclusive: false },
        noAck: false,
      },
    },
    { inheritAppConfig: true },
  );

  // Stop accepting requests, finish the in-flight ones, then exit.
  app.enableShutdownHooks();

  await app.startAllMicroservices();
  await app.listen(configService.getNumber('PORT'), '0.0.0.0');
}

void bootstrap();
