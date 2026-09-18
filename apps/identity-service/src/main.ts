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
import { QUEUES } from '@contracts/messaging/topology';
import { AppModule } from './app.module';
import { IdentityConfig } from './config/identity.config';

/**
 * Request/response microservice. The HTTP listener exists for `/health` only —
 * an orchestrator needs a way to tell a wedged service from a busy one.
 */
async function bootstrap() {
  initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  const config = app.get<ConfigService<IdentityConfig>>(ConfigService);

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.RMQ,
      options: {
        urls: [config.get('RABBITMQ_URL')],
        queue: QUEUES.IDENTITY_RPC,
        queueOptions: { durable: true },
        // Manual ack: a crash redelivers the message instead of losing it.
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
