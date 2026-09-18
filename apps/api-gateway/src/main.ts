import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import compression from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import { Logger } from 'nestjs-pino';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { ConfigService } from '@core/config/config.service';
import { AppModule } from './app.module';
import { GatewayConfig } from './config/gateway.config';

/**
 * The only public HTTP surface. It owns no domain data: everything it serves
 * comes from a message to another service or from object storage.
 */
async function bootstrap() {
  initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

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

  // Stop accepting requests, finish the in-flight ones, then exit.
  app.enableShutdownHooks();

  await app.listen(configService.getNumber('PORT'), '0.0.0.0');
}

void bootstrap();
