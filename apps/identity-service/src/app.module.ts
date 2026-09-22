import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { ConfigModule } from '@core/config/config.module';
import { HealthModule } from '@core/health/health.module';
import { ObservabilityModule } from '@obs/logger.module';

import { identityConfigSchema } from './config/identity.config';
import { PrismaModule } from './database/prisma.module';
import { MessagingModule } from './messaging/messaging.module';

/**
 *
 * Application modules
 *
 */
import { AuthModule } from './modules/auth/auth.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { TokensModule } from './modules/tokens/tokens.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ validationSchema: identityConfigSchema }),
    ObservabilityModule,
    // Owns the `identity` database; no other service reads it.
    PrismaModule,
    HealthModule,
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
  ],
})
export class AppModule {}
