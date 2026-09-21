import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { ConfigService } from '@core/config/config.service';
import { FormatFamily } from '@contracts/enums/conversion.enums';
import { EXCHANGES, QUEUES, ROUTING_KEYS } from '@contracts/messaging/topology';
import { AppModule } from './app.module';
import { ConversionConfig } from './config/conversion.config';

/**
 * Stateless consumer, N replicas. Scales on queue depth; the only service whose
 * work is CPU-bound.
 */
async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  const config = app.get<ConfigService<ConversionConfig>>(ConfigService);
  const family = config.get('CONVERSION_FAMILY') as FormatFamily;

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.RMQ,
      options: {
        urls: [config.get('RABBITMQ_URL')],

        // One work queue per format family, bound to the commands exchange by
        // `convert.<family>` — a 40-minute video cannot block a 200 ms resize.
        exchange: EXCHANGES.CONVERSION_COMMANDS,
        exchangeType: 'direct',
        wildcards: true,
        routingKey: ROUTING_KEYS.convert(family),
        queue: QUEUES.conversionJobs(family),
        queueOptions: {
          durable: true,
          arguments: { 'x-queue-type': 'quorum' },
        },

        // Manual ack with prefetch 1: a worker holds one job, so a crash
        // redelivers exactly one, and the broker spreads load by real capacity
        // rather than round-robin.
        noAck: false,
        prefetchCount: config.getNumber('RABBITMQ_PREFETCH'),
      },
    },
    { inheritAppConfig: true },
  );

  // Stop consuming, finish the in-flight job, then exit — a deploy never kills
  // a running conversion.
  app.enableShutdownHooks();

  await app.startAllMicroservices();
  await app.listen(config.getNumber('PORT'), '0.0.0.0');
}

void bootstrap();
