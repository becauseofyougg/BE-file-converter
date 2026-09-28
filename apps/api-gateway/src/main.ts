import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { ConfigService } from '@core/config/config.service';
import { EXCHANGES, QUEUES } from '@contracts/messaging/topology';
import { AppModule } from './app.module';
import { GatewayConfig } from './config/gateway.config';
import { configureHttpApp } from './http-app';
import { setupOpenApi } from './openapi';

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

  await configureHttpApp(app);

  const configService = app.get<ConfigService<GatewayConfig>>(ConfigService);

  // Generated from the DTOs, so it cannot drift from the code. Served outside
  // production: an OpenAPI document is a map of the attack surface, and the
  // people who need it in production can read it from the repository.
  if (configService.get('NODE_ENV') !== 'production') {
    setupOpenApi(app);
  }

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
