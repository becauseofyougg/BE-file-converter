import { Module } from '@nestjs/common';

import { AuthSettingsService } from './auth-settings.service';
import { VerificationService } from './verification.service';

/**
 * The confirmation-challenge lifecycle, on its own.
 *
 * Split out of AuthModule when the email change came to need it: AuthModule
 * imports UsersModule, so leaving it there would have made UsersModule import
 * AuthModule back. A `forwardRef` would have papered over that, but the honest
 * reading is that issuing and consuming a challenge is not specific to
 * authentication — registration, login and an address change all lean on the
 * same rules, and they now lean on the same module.
 */
@Module({
  providers: [AuthSettingsService, VerificationService],
  exports: [AuthSettingsService, VerificationService],
})
export class VerificationModule {}
