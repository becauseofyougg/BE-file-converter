import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { ThrottlerModule } from '@core/throttler/throttler.module';
import { RbacGuard } from '../rbac/rbac.guard';
import { AuthGuardsModule } from './auth-guards.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailRateLimitGuard } from './email-rate-limit.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionCookiesService } from './session-cookies.service';

@Module({
  // For `ThrottlerStorage`, which the per-email guard counts in. An export is
  // only visible to modules that import it, so relying on AppModule having
  // imported the throttler is not enough.
  imports: [ThrottlerModule, AuthGuardsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionCookiesService,
    EmailRateLimitGuard,
    // Registered globally and in this order: authenticate, then authorise.
    // Opt-*out* via `@Public()`, so a new controller is protected by default
    // and a forgotten decorator fails closed.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
  ],
})
export class AuthModule {}
