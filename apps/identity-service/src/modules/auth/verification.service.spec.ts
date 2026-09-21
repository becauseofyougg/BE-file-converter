import { TransactionHost } from '@nestjs-cls/transactional';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';
import { AuthSettingsService } from './auth-settings.service';
import {
  MAX_ATTEMPTS,
  MAX_RESENDS_PER_HOUR,
  OTP_LENGTH,
  RESEND_INTERVAL_MS,
  VerificationService,
  generateOtp,
  hashSecret,
  type VerificationToken,
} from './verification.service';

/** The delegate the service reaches through `txHost.tx.verificationToken`. */
interface MockDelegate {
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  findFirst: jest.Mock;
  deleteMany: jest.Mock;
}

/**
 * Stands in for the CLS transaction host. Outside a transaction the real one
 * hands back the base client, which is exactly what a unit test wants.
 */
function transactionHost(delegate: MockDelegate): TransactionHost {
  return { tx: { verificationToken: delegate } } as unknown as TransactionHost;
}

function buildToken(
  overrides: Partial<VerificationToken> = {},
): VerificationToken {
  return {
    id: 'token-1',
    userId: 'user-1',
    type: 'email_verification',
    challengeId: 'challenge-1',
    tokenHash: hashSecret('123456'),
    method: 'otp',
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    attempts: 0,
    resendCount: 0,
    lastSentAt: new Date(Date.now() - RESEND_INTERVAL_MS - 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as VerificationToken;
}

describe('VerificationService', () => {
  let db: MockDelegate;
  let settings: jest.Mocked<Pick<AuthSettingsService, 'confirmationMethod'>>;
  let service: VerificationService;

  beforeEach(() => {
    db = {
      create: jest.fn().mockResolvedValue(buildToken()),
      update: jest.fn().mockResolvedValue(buildToken()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    };

    settings = { confirmationMethod: jest.fn().mockReturnValue('otp') };

    service = new VerificationService(
      transactionHost(db),
      settings as unknown as AuthSettingsService,
    );
  });

  describe('generateOtp', () => {
    it('always produces exactly six digits, including leading zeros', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(generateOtp()).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`));
      }
    });
  });

  describe('issue', () => {
    it('stores only the hash, never the secret', async () => {
      const challenge = await service.issue('user-1');

      const [firstCall] = db.create.mock.calls as [
        { data: VerificationToken },
      ][];
      const saved = firstCall[0].data;

      expect(saved.tokenHash).toBe(hashSecret(challenge.secret));
      expect(JSON.stringify(saved)).not.toContain(challenge.secret);
    });

    it('consumes any live challenge first, so only one code is ever valid', async () => {
      await service.issue('user-1');

      expect(db.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ userId: 'user-1', usedAt: null }),
        data: { usedAt: expect.any(Date) },
      });
    });

    it('issues a 256-bit token with a longer TTL when the method is link', async () => {
      settings.confirmationMethod.mockReturnValue('link');
      db.create.mockResolvedValue(buildToken({ method: 'link' }));

      const challenge = await service.issue('user-1');

      expect(challenge.method).toBe('link');
      expect(Buffer.from(challenge.secret, 'base64url')).toHaveLength(32);
      expect(challenge.expiresAt.getTime() - Date.now()).toBeGreaterThan(
        60 * 60 * 1000,
      );
    });
  });

  describe('consume', () => {
    it('accepts the correct code and marks the challenge used', async () => {
      const token = buildToken();

      await service.consume(token, '123456');

      expect(db.updateMany).toHaveBeenCalledWith({
        where: { id: token.id, usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
    });

    it('rejects a wrong code and counts the attempt', async () => {
      const token = buildToken();

      await expect(service.consume(token, '000000')).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_INVALID }),
      );
      expect(db.update).toHaveBeenCalledWith({
        where: { id: token.id },
        data: { attempts: { increment: 1 } },
      });
    });

    it('reports attempts exceeded on the attempt that reaches the cap', async () => {
      const token = buildToken({ attempts: MAX_ATTEMPTS - 1 });

      await expect(service.consume(token, '000000')).rejects.toThrow(
        expect.objectContaining({
          code: ERROR_CODES.CONFIRMATION_ATTEMPTS_EXCEEDED,
        }),
      );
    });

    it('refuses once the cap is reached, even with the right code', async () => {
      const token = buildToken({ attempts: MAX_ATTEMPTS });

      await expect(service.consume(token, '123456')).rejects.toThrow(
        expect.objectContaining({
          code: ERROR_CODES.CONFIRMATION_ATTEMPTS_EXCEEDED,
        }),
      );
    });

    it('reports an expired challenge distinctly from an invalid one', async () => {
      const token = buildToken({ expiresAt: new Date(Date.now() - 1) });

      await expect(service.consume(token, '123456')).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_EXPIRED }),
      );
    });

    it('refuses a challenge that was already used', async () => {
      const token = buildToken({ usedAt: new Date() });

      await expect(service.consume(token, '123456')).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_INVALID }),
      );
    });

    /**
     * Two requests carrying the same valid code both pass the comparison; the
     * conditional update is what makes exactly one of them win.
     */
    it('treats a lost race for the same code as invalid', async () => {
      db.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.consume(buildToken(), '123456')).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_INVALID }),
      );
    });
  });

  describe('assertResendAllowed', () => {
    it('refuses inside the 60-second window and says how long to wait', () => {
      const token = buildToken({ lastSentAt: new Date() });

      try {
        service.assertResendAllowed(token);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.RESEND_TOO_SOON);
        expect((error as AppError).details).toEqual(
          expect.objectContaining({
            retryAfterSeconds: expect.any(Number),
          }),
        );
      }
    });

    it('allows a resend once the interval has passed', () => {
      expect(() => service.assertResendAllowed(buildToken())).not.toThrow();
    });

    it('refuses past the hourly cap', () => {
      const token = buildToken({
        resendCount: MAX_RESENDS_PER_HOUR,
        lastSentAt: new Date(Date.now() - RESEND_INTERVAL_MS - 1000),
      });

      expect(() => service.assertResendAllowed(token)).toThrow(
        expect.objectContaining({ code: ERROR_CODES.RESEND_TOO_SOON }),
      );
    });

    it('starts a new hourly window once the old one has lapsed', () => {
      const token = buildToken({
        resendCount: MAX_RESENDS_PER_HOUR,
        lastSentAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });

      expect(() => service.assertResendAllowed(token)).not.toThrow();
    });
  });

  describe('rotate', () => {
    it('keeps the challenge id, replaces the secret and clears the attempts', async () => {
      const token = buildToken({ attempts: 3 });

      const challenge = await service.rotate(token);

      expect(challenge.challengeId).toBe(token.challengeId);
      expect(hashSecret(challenge.secret)).not.toBe(token.tokenHash);
      expect(db.update).toHaveBeenCalledWith({
        where: { id: token.id },
        data: expect.objectContaining({ attempts: 0, usedAt: null }),
      });
    });

    it('will not rotate while the resend interval is still open', async () => {
      const token = buildToken({ lastSentAt: new Date() });

      await expect(service.rotate(token)).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.RESEND_TOO_SOON }),
      );
    });
  });
});
