import { Module } from '@nestjs/common';

import { ConfigModule } from '@core/config/config.module';
import { HealthModule } from '@core/health/health.module';
import { ObservabilityModule } from '@obs/logger.module';

import { notificationConfigSchema } from './config/notification.config';
import { PrismaModule } from './database/prisma.module';

/**
 *
 * Application modules
 *
 */
import { MailerModule } from './modules/mailer/mailer.module';
import { TemplatesModule } from './modules/templates/templates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ validationSchema: notificationConfigSchema }),
    ObservabilityModule,
    // Owns the `notification` schema — the send log and its idempotency keys.
    PrismaModule,
    HealthModule,
    /**
     *
     * Application modules
     *
     */
    MailerModule,
    TemplatesModule,
  ],
})
export class AppModule {}
