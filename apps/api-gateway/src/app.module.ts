import { Module } from '@nestjs/common';

import { ConfigModule } from '@core/config/config.module';
import { HealthModule } from '@core/health/health.module';
import { ThrottlerModule } from '@core/throttler/throttler.module';
import { ObservabilityModule } from '@obs/logger.module';
import { StorageModule } from '@storage/storage.module';

import { gatewayConfigSchema } from './config/gateway.config';
import { MessagingModule } from './messaging/messaging.module';

/**
 *
 * Application modules
 *
 */
import { AuthModule } from './modules/auth/auth.module';
import { ConversionsModule } from './modules/conversions/conversions.module';
import { FormatsModule } from './modules/formats/formats.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ validationSchema: gatewayConfigSchema }),
    ObservabilityModule,
    HealthModule,
    ThrottlerModule,
    StorageModule,
    MessagingModule,
    /**
     *
     * Application modules
     *
     */
    // Before AuthModule, which registers the global guards that read its cache.
    RbacModule,
    AuthModule,
    UsersModule,
    ConversionsModule,
    FormatsModule,
  ],
})
export class AppModule {}
