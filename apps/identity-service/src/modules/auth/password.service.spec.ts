import { AppError } from '@core/errors/app-error';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordService,
} from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  describe('assertMeetsPolicy', () => {
    it('accepts a long passphrase with no special characters', () => {
      expect(() => service.assertMeetsPolicy('sixteen chars ok')).not.toThrow();
    });

    it('rejects a password shorter than the minimum', () => {
      expect(() =>
        service.assertMeetsPolicy('a'.repeat(PASSWORD_MIN_LENGTH - 1)),
      ).toThrow(AppError);
    });

    it('accepts one exactly at the minimum', () => {
      expect(() =>
        service.assertMeetsPolicy('a1b2c3d4e5f6'.slice(0, PASSWORD_MIN_LENGTH)),
      ).not.toThrow();
    });

    // The cap is what stops a multi-megabyte body becoming CPU exhaustion,
    // since argon2's cost scales with the input it is handed.
    it('rejects one longer than the maximum', () => {
      expect(() =>
        service.assertMeetsPolicy('a'.repeat(PASSWORD_MAX_LENGTH + 1)),
      ).toThrow(AppError);
    });

    it('rejects a deny-listed password regardless of case', () => {
      expect(() => service.assertMeetsPolicy('PassWord1234')).toThrow(
        expect.objectContaining({ code: ERROR_CODES.PASSWORD_TOO_WEAK }),
      );
    });

    it('reports PASSWORD_TOO_WEAK rather than a generic validation failure', () => {
      expect.assertions(2);

      try {
        service.assertMeetsPolicy('short');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.PASSWORD_TOO_WEAK);
      }
    });
  });

  describe('hash / verify', () => {
    // argon2id is deliberately slow; these two are the only tests that pay it.
    jest.setTimeout(20_000);

    it('produces an argon2id hash that verifies', async () => {
      const hash = await service.hash('a decent passphrase');

      expect(hash.startsWith('$argon2id$')).toBe(true);
      expect(await service.verify(hash, 'a decent passphrase')).toBe(true);
    });

    it('rejects a wrong password and a corrupt hash without throwing', async () => {
      const hash = await service.hash('a decent passphrase');

      expect(await service.verify(hash, 'a different one')).toBe(false);
      expect(await service.verify('not-a-hash', 'anything')).toBe(false);
    });

    it('salts each hash, so the same password hashes differently', async () => {
      const [first, second] = await Promise.all([
        service.hash('the same passphrase'),
        service.hash('the same passphrase'),
      ]);

      expect(first).not.toEqual(second);
    });
  });
});
