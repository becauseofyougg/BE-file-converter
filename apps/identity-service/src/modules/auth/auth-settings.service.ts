import { Injectable } from '@nestjs/common';

import { ConfigService } from '@core/config/config.service';
import type { ConfirmationMethod } from '@contracts/messages/identity.messages';
import { IdentityConfig } from '../../config/identity.config';

/**
 * The administrator-facing switches of docs/REGISTRATION.md §2.
 *
 * The requirement says *the administrator* toggles these, which strictly means
 * a runtime switch and therefore a settings table plus an admin endpoint. That
 * only pays for itself once an admin surface exists at all, so for now the
 * source is the Joi-validated environment — but every caller reads them
 * through this service, so swapping in a cached table later changes one
 * provider and no call sites. Reading through an interface from day one is
 * what makes that swap free.
 */
@Injectable()
export class AuthSettingsService {
  constructor(private readonly config: ConfigService<IdentityConfig>) {}

  confirmRegistration(): boolean {
    return this.config.getBoolean('AUTH_CONFIRM_REGISTRATION');
  }

  confirmPasswordReset(): boolean {
    return this.config.getBoolean('AUTH_CONFIRM_PASSWORD_RESET');
  }

  confirmLogin(): boolean {
    return this.config.getBoolean('AUTH_CONFIRM_LOGIN');
  }

  confirmationMethod(): ConfirmationMethod {
    return this.config.get('AUTH_CONFIRM_METHOD') === 'link' ? 'link' : 'otp';
  }
}
