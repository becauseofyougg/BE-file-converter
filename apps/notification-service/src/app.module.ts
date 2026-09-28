import { Module } from '@nestjs/common';

import { ConfigModule } from '@core/config/config.module';
import { HealthModule } from '@core/health/health.module';
import { databaseProbe } from '@core/health/health.probes';
import { ObservabilityModule } from '@obs/logger.module';

import { notificationConfigSchema } from './config/notification.config';
import { PrismaModule } from './database/prisma.module';
import { PrismaService } from './database/prisma.service';

/**
 *
 * Application modules
 *
 */
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({ validationSchema: notificationConfigSchema }),
    ObservabilityModule,
    // Owns the `notification` schema — the send log and its idempotency keys.
    PrismaModule,
    // The send log and its idempotency keys. SMTP is deliberately not probed: a
    // provider that is briefly refusing connections should send mail up the
    // retry ladder, not take the whole replica out of rotation.
    HealthModule.register({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => [databaseProbe(prisma)],
    }),
    /**
     *
     * Application modules
     *
     */
    // Consumes the events that end in an inbox; brings the mailer and the
    // templates with it.
    NotificationsModule,
  ],
})
export class AppModule {}
