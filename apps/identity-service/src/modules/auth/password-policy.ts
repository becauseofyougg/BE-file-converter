import { Injectable } from '@nestjs/common';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';
import { COMMON_PASSWORDS } from './common-passwords';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * What a new password must satisfy — a product rule, independent of how the
 * password is then hashed. An injectable class rather than a function so a
 * stricter one (a breached-password lookup, say) can be bound in its place.
 */
@Injectable()
export class PasswordPolicy {
  /**
   * Length over composition. Forced upper/lower/digit/symbol rules push people
   * to `Password1!` — cheap for an attacker who knows the rule and annoying
   * for everyone else — whereas length is what actually costs work. The
   * maximum bounds the hashing input so a multi-megabyte password cannot be
   * turned into a denial-of-service vector.
   */
  assertMeetsPolicy(plaintext: string): void {
    if (
      plaintext.length < PASSWORD_MIN_LENGTH ||
      plaintext.length > PASSWORD_MAX_LENGTH
    ) {
      throw new AppError(
        ERROR_CODES.PASSWORD_TOO_WEAK,
        `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
        400,
      );
    }

    if (COMMON_PASSWORDS.has(plaintext.toLowerCase())) {
      throw new AppError(
        ERROR_CODES.PASSWORD_TOO_WEAK,
        'This password is among the most commonly used and is not accepted',
        400,
      );
    }
  }
}
