import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ConfigService } from '@core/config/config.service';
import { GatewayConfig } from '../../config/gateway.config';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Token verification, separate from `AuthModule` so the RBAC module can depend
 * on it without dragging in the auth routes — and so the guards stay available
 * to every feature module.
 *
 * Verification only: the gateway never signs a token. `signOptions` are absent
 * on purpose, so a mistake here cannot turn the edge into an issuer.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<GatewayConfig>) => ({
        secret: config.get('JWT_SECRET'),
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  providers: [JwtAuthGuard],
  exports: [JwtModule, JwtAuthGuard],
})
export class AuthGuardsModule {}
