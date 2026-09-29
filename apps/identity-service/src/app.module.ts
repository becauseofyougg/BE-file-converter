import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { ConfigModule } from '@core/config/config.module';
import { RmqAckInterceptor } from '@core/messaging/rmq-ack';
import { HealthModule } from '@core/health/health.module';
import { databaseProbe } from '@core/health/health.probes';
import { ObservabilityModule } from '@obs/logger.module';

import { identityConfigSchema } from './config/identity.config';
import { PrismaModule } from './database/prisma.module';
import { PrismaService } from './database/prisma.service';
import { MessagingModule } from './messaging/messaging.module';

/**
 *
 * Application modules
 *
 */
import { AuthModule } from './modules/auth/auth.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { TokensModule } from './modules/tokens/tokens.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ validationSchema: identityConfigSchema }),
    ObservabilityModule,
    // Owns the `identity` database; no other service reads it.
    PrismaModule,
    // Identity answers over the broker, so an unreachable broker means nothing
    // reaches this service at all and the probe would never be asked. What it
    // can usefully report is its own database.
    HealthModule.register({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => [databaseProbe(prisma)],
    }),
    // Drives the outbox relay and the unverified-account cleanup.
    ScheduleModule.forRoot(),
    MessagingModule,
    /**
     *
     * Application modules
     *
     */
    AuthModule,
    UsersModule,
    TokensModule,
    OutboxModule,
    RbacModule,
  ],
  providers: [
    // Every RPC message is acked, whatever became of it — including a payload
    // the ValidationPipe refused before any handler ran. Without this, one
    // such message took the only prefetch slot and identity stopped answering.
    { provide: APP_INTERCEPTOR, useClass: RmqAckInterceptor },
  ],
})
export class AppModule {}
