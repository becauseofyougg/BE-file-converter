import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { TokensModule } from '../tokens/tokens.module';
import { UsersModule } from '../users/users.module';
import { Argon2PasswordHasher } from './argon2-password-hasher';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginService } from './login.service';
import { PASSWORD_HASHER } from './password-hasher';
import { PasswordPolicy } from './password-policy';
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
    PasswordPolicy,
    // The hashing algorithm — see password-hasher.ts before replacing it: the
    // rows already in the database are in this one's format.
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    VerificationCleanupJob,
  ],
  // VerificationModule is re-exported, so importers keep getting
  // AuthSettingsService and VerificationService as they did before the split.
  exports: [AuthService, LoginService, RefreshService, VerificationModule],
})
export class AuthModule {}
