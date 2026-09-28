import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';
import { COMMON_PASSWORDS } from './common-passwords';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * argon2id parameters. Memory-hard is the property that matters: it is what
 * makes a GPU farm no cheaper per guess than the server that created the hash.
 *
 * `m=19456` (19 MiB) and `t=2` is the OWASP-recommended starting point, and
 * should be re-measured on the target hardware for a ~100 ms cost per hash.
 * The parameters are encoded in the hash string, so raising them later leaves
 * existing hashes verifiable and they can be upgraded on next login.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordService {
  hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, ARGON2_OPTIONS);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // A malformed hash in the column is a data problem, not a valid login.
      return false;
    }
  }

  /**
   * Length over composition. Forced upper/lower/digit/symbol rules push people
   * to `Password1!` — cheap for an attacker who knows the rule and annoying
   * for everyone else — whereas length is what actually costs work. The
   * maximum bounds the argon2 input so a multi-megabyte password cannot be
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

  /**
   * Spends one verification's worth of CPU against a throwaway hash.
   *
   * Login must take the same time whether or not the address exists. Returning
   * early when the lookup misses turns response latency into an
   * account-existence oracle, and no amount of neutral wording in the error
   * body hides a reply that comes back ten times faster.
   */
  async burnVerificationTime(): Promise<void> {
    await argon2.verify(await this.dummyHash(), 'not-the-password');
  }

  /**
   * Hashed once per process, not per call: the point is to match the cost of a
   * *verify*, and hashing here as well would make the miss path slower than
   * the hit path — the same oracle, pointing the other way.
   */
  private dummyHashPromise: Promise<string> | null = null;

  private dummyHash(): Promise<string> {
    this.dummyHashPromise ??= argon2.hash(
      'timing-equalisation-placeholder',
      ARGON2_OPTIONS,
    );

    return this.dummyHashPromise;
  }
}
