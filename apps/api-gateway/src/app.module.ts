import { Module } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';

import { ConfigModule } from '@core/config/config.module';
import { brokerProbe, storageProbe } from '@core/health/broker.probe';
import { HealthModule } from '@core/health/health.module';
import { HEALTH_PROBES } from '@core/health/health.probes';
import { ThrottlerModule } from '@core/throttler/throttler.module';
import { ObservabilityModule } from '@obs/logger.module';
import { StorageModule } from '@storage/storage.module';
import { StorageService } from '@storage/storage.service';

import { gatewayConfigSchema } from './config/gateway.config';
import { IDENTITY_CLIENT, MessagingModule } from './messaging/messaging.module';

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
  providers: [
    {
      // The gateway owns no database, so it reports on the two things it
      // cannot serve a request without: the broker it asks identity through,
      // and the bucket it presigns from.
      provide: HEALTH_PROBES,
      inject: [IDENTITY_CLIENT, StorageService],
      useFactory: (identity: ClientProxy, storage: StorageService) => [
        brokerProbe(identity),
        storageProbe(storage),
      ],
    },
  ],
})
export class AppModule {}
