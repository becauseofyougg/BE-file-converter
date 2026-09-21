import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/outbox.module';
import { TokensModule } from '../tokens/tokens.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSettingsService } from './auth-settings.service';
import { PasswordService } from './password.service';
import { VerificationCleanupJob } from './verification-cleanup.job';
import { VerificationService } from './verification.service';

@Module({
  imports: [UsersModule, TokensModule, OutboxModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthSettingsService,
    PasswordService,
    VerificationService,
    VerificationCleanupJob,
  ],
  exports: [AuthService, AuthSettingsService],
})
export class AuthModule {}
