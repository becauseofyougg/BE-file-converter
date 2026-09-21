import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { ConfigService } from '@core/config/config.service';
import { EXCHANGES, QUEUES } from '@contracts/messaging/topology';
import { AppModule } from './app.module';
import { NotificationConfig } from './config/notification.config';

/**
 * Event subscriber. Email is slow and flaky, which is exactly why it lives
 * behind a queue and cannot fail a registration or a conversion.
 */
async function bootstrap() {
  initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  const config = app.get<ConfigService<NotificationConfig>>(ConfigService);

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.RMQ,
      options: {
        urls: [config.get('RABBITMQ_URL')],

        // Fan-out: the queue is bound to `domain.events` by each handler's
        // `@EventPattern`, so subscribing to a new fact is one decorator.
        exchange: EXCHANGES.DOMAIN_EVENTS,
        exchangeType: 'topic',
        wildcards: true,
        queue: QUEUES.NOTIFICATIONS,
        queueOptions: {
          durable: true,
          arguments: { 'x-queue-type': 'quorum' },
        },

        noAck: false,
        prefetchCount: config.getNumber('RABBITMQ_PREFETCH'),
      },
    },
    { inheritAppConfig: true },
  );

  app.enableShutdownHooks();

  await app.startAllMicroservices();
  await app.listen(config.getNumber('PORT'), '0.0.0.0');
}

void bootstrap();
