import { Argon2PasswordHasher } from './argon2-password-hasher';

describe('Argon2PasswordHasher', () => {
  const service = new Argon2PasswordHasher();

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

  /**
   * docs/AUTHENTICATION.md §3. Login must take the same time whether or not
   * the address exists — returning early on a missed lookup turns response
   * latency into an account-existence oracle, and no wording in the error body
   * hides a reply that comes back ten times faster.
   */
  describe('burnVerificationTime', () => {
    it('resolves without throwing, so a missed lookup still refuses cleanly', async () => {
      await expect(service.burnVerificationTime()).resolves.toBeUndefined();
    });

    it('costs about what a real verification costs', async () => {
      const hash = await service.hash('a perfectly fine passphrase');

      const realStart = process.hrtime.bigint();
      await service.verify(hash, 'a perfectly fine passphrase');
      const real = Number(process.hrtime.bigint() - realStart);

      const burnStart = process.hrtime.bigint();
      await service.burnVerificationTime();
      const burn = Number(process.hrtime.bigint() - burnStart);

      // Generous, because CI timing is noisy — but an early return would be
      // orders of magnitude apart, not a factor of five.
      expect(burn).toBeGreaterThan(real / 5);
    }, 20_000);

    /**
     * Hashed once per process, not per call: the point is to match the cost of
     * a *verify*, and hashing here as well would make the miss path slower
     * than the hit path — the same oracle, pointing the other way.
     */
    it('reuses one throwaway hash rather than making a new one each time', async () => {
      await service.burnVerificationTime();

      const start = process.hrtime.bigint();
      await service.burnVerificationTime();
      const second = Number(process.hrtime.bigint() - start) / 1e6;

      expect(second).toBeLessThan(1000);
    }, 20_000);
  });
});
