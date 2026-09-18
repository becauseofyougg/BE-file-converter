import { join } from 'node:path';

import { Module } from '@nestjs/common';

import { ConfigModule } from '@core/config/config.module';
import { DatabaseModule } from '@core/database/database.module';
import { HealthModule } from '@core/health/health.module';
import { ObservabilityModule } from '@obs/logger.module';

import { identityConfigSchema } from './config/identity.config';

/**
 *
 * Application modules
 *
 */
import { AuthModule } from './modules/auth/auth.module';
import { TokensModule } from './modules/tokens/tokens.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ validationSchema: identityConfigSchema }),
    ObservabilityModule,
    // Owns the `identity` schema; no other service reads it.
    DatabaseModule.forRoot({
      migrations: [join(__dirname, 'database/migrations/*.migration{.ts,.js}')],
    }),
    HealthModule,
    /**
     *
     * Application modules
     *
     */
    AuthModule,
    UsersModule,
    TokensModule,
  ],
})
export class AppModule {}
