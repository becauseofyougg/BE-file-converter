import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { TokensModule } from '../tokens/tokens.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginService } from './login.service';
import { PasswordService } from './password.service';
import { RefreshService } from './refresh.service';
import { VerificationCleanupJob } from './verification-cleanup.job';
import { VerificationModule } from './verification.module';

@Module({
  imports: [
    UsersModule,
    TokensModule,
    OutboxModule,
    RbacModule,
    VerificationModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginService,
    RefreshService,
    PasswordService,
    VerificationCleanupJob,
  ],
  // VerificationModule is re-exported, so importers keep getting
  // AuthSettingsService and VerificationService as they did before the split.
  exports: [AuthService, LoginService, RefreshService, VerificationModule],
})
export class AuthModule {}
