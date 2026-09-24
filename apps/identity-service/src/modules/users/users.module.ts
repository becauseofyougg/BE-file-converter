import { Module } from '@nestjs/common';

import { VerificationModule } from '../auth/verification.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { AccountDeletionService } from './account-deletion.service';
import { EmailChangeService } from './email-change.service';
import { ProfileUpdateService } from './profile-update.service';
import { ProfileService } from './profile.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // RbacModule for the config and the role names; OutboxModule to announce an
  // address change; VerificationModule for the challenge lifecycle, which the
  // email change reuses rather than reimplementing — docs/PROFILE-UPDATE.md §4.
  imports: [RbacModule, OutboxModule, VerificationModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    ProfileService,
    ProfileUpdateService,
    EmailChangeService,
    AccountDeletionService,
  ],
  exports: [UsersService, ProfileService],
})
export class UsersModule {}
