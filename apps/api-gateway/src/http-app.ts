import compression from '@fastify/compress';
import fastifyCookie from '@fastify/cookie';
import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ConfigService } from '@core/config/config.service';
import { HttpAppExceptionFilter } from '@core/errors/http-exception.filter';
import { GatewayConfig } from './config/gateway.config';

/**
 * Everything that turns the Nest app into the HTTP surface a client sees:
 * compression, validation, the error envelope, CORS, cookies.
 *
 * One function, called by `main.ts` and by the e2e suite alike. Before it
 * existed the e2e app was built without any of this — on Express, with no
 * exception filter — so every refusal a test provoked came back as a 500 and
 * the suite could only ever check `/health`.
 */
export async function configureHttpApp(
  app: NestFastifyApplication,
): Promise<void> {
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
}
