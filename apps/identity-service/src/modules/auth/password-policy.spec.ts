import { AppError } from '@core/errors/app-error';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordPolicy,
} from './password-policy';

describe('PasswordPolicy', () => {
  const policy = new PasswordPolicy();

  it('accepts a long passphrase with no special characters', () => {
    expect(() => policy.assertMeetsPolicy('sixteen chars ok')).not.toThrow();
  });

  it('rejects a password shorter than the minimum', () => {
    expect(() =>
      policy.assertMeetsPolicy('a'.repeat(PASSWORD_MIN_LENGTH - 1)),
    ).toThrow(AppError);
  });

  it('accepts one exactly at the minimum', () => {
    expect(() =>
      policy.assertMeetsPolicy('a1b2c3d4e5f6'.slice(0, PASSWORD_MIN_LENGTH)),
    ).not.toThrow();
  });

  // The cap is what stops a multi-megabyte body becoming CPU exhaustion,
  // since the hasher's cost scales with the input it is handed.
  it('rejects one longer than the maximum', () => {
    expect(() =>
      policy.assertMeetsPolicy('a'.repeat(PASSWORD_MAX_LENGTH + 1)),
    ).toThrow(AppError);
  });

  it('rejects a deny-listed password regardless of case', () => {
    expect(() => policy.assertMeetsPolicy('PassWord1234')).toThrow(
      expect.objectContaining({ code: ERROR_CODES.PASSWORD_TOO_WEAK }),
    );
  });

  it('reports PASSWORD_TOO_WEAK rather than a generic validation failure', () => {
    expect.assertions(2);

    try {
      policy.assertMeetsPolicy('short');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ERROR_CODES.PASSWORD_TOO_WEAK);
    }
  });
});
