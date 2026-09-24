import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ConfigService } from '@core/config/config.service';
import { GatewayConfig } from '../../config/gateway.config';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionCookiesService } from './session-cookies.service';

/**
 * Token verification, separate from `AuthModule` so the RBAC module can depend
 * on it without dragging in the auth routes — and so the guards stay available
 * to every feature module.
 *
 * Verification only: the gateway never signs a token. `signOptions` are absent
 * on purpose, so a mistake here cannot turn the edge into an issuer.
 *
 * `SessionCookiesService` lives here rather than in `AuthModule` because
 * erasing an account clears the same cookies logging out does, and two modules
 * writing session cookies through two copies of the rules is how they drift
 * apart.
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
  providers: [JwtAuthGuard, SessionCookiesService],
  exports: [JwtModule, JwtAuthGuard, SessionCookiesService],
})
export class AuthGuardsModule {}
