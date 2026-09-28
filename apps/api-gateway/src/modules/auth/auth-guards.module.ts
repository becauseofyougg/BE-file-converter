import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ConfigService } from '@core/config/config.service';
import { GatewayConfig } from '../../config/gateway.config';
import { AuthenticationGuard } from './authentication.guard';
import { AUTHENTICATORS, type Authenticator } from './authenticator';
import { JwtAuthenticator } from './authenticators/jwt.authenticator';
import { SessionCookiesService } from './session-cookies.service';

/**
 * Authentication, separate from `AuthModule` so the RBAC module can depend on
 * it without dragging in the auth routes — and so the guard stays available to
 * every feature module.
 *
 * **Adding a scheme** is a class implementing `Authenticator`, listed in the
 * `AUTHENTICATORS` factory below, in precedence order. Nothing else changes:
 * not the guard, not RBAC, not a controller.
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
  providers: [
    JwtAuthenticator,
    {
      provide: AUTHENTICATORS,
      inject: [JwtAuthenticator],
      useFactory: (...authenticators: Authenticator[]): Authenticator[] =>
        authenticators,
    },
    AuthenticationGuard,
    SessionCookiesService,
  ],
  exports: [AUTHENTICATORS, AuthenticationGuard, SessionCookiesService],
})
export class AuthGuardsModule {}
