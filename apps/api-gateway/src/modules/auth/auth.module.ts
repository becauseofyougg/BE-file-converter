import { Module } from '@nestjs/common';

import { ThrottlerModule } from '@core/throttler/throttler.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailRateLimitGuard } from './email-rate-limit.guard';

@Module({
  // For `ThrottlerStorage`, which the per-email guard counts in. An export is
  // only visible to modules that import it, so relying on AppModule having
  // imported the throttler is not enough.
  imports: [ThrottlerModule],
  controllers: [AuthController],
  providers: [AuthService, EmailRateLimitGuard],
})
export class AuthModule {}
