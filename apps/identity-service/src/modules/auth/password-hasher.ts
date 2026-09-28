/**
 * Turns a password into something storable and checks one against it.
 *
 * Separate from {@link PasswordPolicy} because the two change for different
 * reasons: the policy is a product rule, the hasher an algorithm. Today it is
 * argon2id ({@link Argon2PasswordHasher}); a replacement is bound to
 * {@link PASSWORD_HASHER} in `AuthModule`.
 *
 * What an implementation must keep true:
 * - `verify` never throws. A malformed or foreign hash is a failed login, not
 *   a 500 — an erased account's hash is deliberately not valid argon2.
 * - `burnVerificationTime` costs what a real `verify` costs, or login answers
 *   faster for unknown addresses and becomes an account-existence oracle.
 *
 * Changing algorithm on a live database is not just a swap: existing rows hold
 * the old format. The usual route is an implementation that verifies both and
 * hashes only in the new one, re-hashing each account at its next login.
 */
export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
  /** Spends one verification's worth of time and proves nothing. */
  burnVerificationTime(): Promise<void>;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
