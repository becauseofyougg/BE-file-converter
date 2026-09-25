import { Module } from '@nestjs/common';

import { ConfigModule } from '@core/config/config.module';
import { HealthModule } from '@core/health/health.module';
import { HEALTH_PROBES, databaseProbe } from '@core/health/health.probes';
import { ObservabilityModule } from '@obs/logger.module';

import { notificationConfigSchema } from './config/notification.config';
import { PrismaModule } from './database/prisma.module';
import { PrismaService } from './database/prisma.service';

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
  providers: [
    {
      // The send log and its idempotency keys. SMTP is deliberately not probed:
      // a provider that is briefly refusing connections should retry from the
      // queue, not take the whole replica out of rotation.
      provide: HEALTH_PROBES,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => [databaseProbe(prisma)],
    },
  ],
})
export class AppModule {}
