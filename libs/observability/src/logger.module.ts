import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';

import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { ConfigService } from '@core/config/config.service';
import { BaseConfig } from '@core/config/config.types';
import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';

/**
 * Structured JSON logs to stdout, one line per event.
 *
 * The correlation id is taken from the inbound header or generated at the edge,
 * and travels from there through RabbitMQ headers into every worker log line —
 * without it, a failed conversion cannot be traced across four services.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<BaseConfig>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          base: { service: config.get('SERVICE_NAME') },

          genReqId: (req: IncomingMessage) =>
            (req.headers?.[CORRELATION_ID_HEADER] as string) ?? randomUUID(),
          customProps: (req: IncomingMessage) => ({
            correlationId: (req as never as { id: string }).id,
          }),

          // Redaction lives here rather than at the call sites, so it holds even
          // when someone logs a whole DTO. See NON-FUNCTIONAL-REQUIREMENTS.md §6.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              '*.password',
              '*.passwordHash',
              '*.password_hash',
              '*.accessToken',
              '*.refreshToken',
              '*.token',
              '*.tokenHash',
              '*.code',
              '*.secret',
            ],
            censor: '[REDACTED]',
          },

          // Probes would otherwise be the majority of the log volume.
          autoLogging: {
            ignore: (req: IncomingMessage) =>
              req.url?.startsWith('/health') ?? false,
          },

          transport:
            config.get('NODE_ENV') === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class ObservabilityModule {}
