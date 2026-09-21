/**
 * `@Transactional()` resolves the CLS transaction host at call time, which a
 * unit test has no reason to own — the transaction boundary itself is an
 * integration concern (NON-FUNCTIONAL-REQUIREMENTS.md §7). Returning the
 * untouched descriptor leaves the method's own behaviour exactly as written.
 */
jest.mock('@nestjs-cls/transactional', () => ({
  Transactional:
    () =>
    (
      _target: unknown,
      _key: string,
      descriptor: PropertyDescriptor,
    ): PropertyDescriptor =>
      descriptor,
  TransactionHost: class {},
}));

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { DOMAIN_EVENTS } from '@contracts/events/domain.events';
import { AppError } from '@core/errors/app-error';
import { OutboxService } from '../outbox/outbox.service';
import { TokensService } from '../tokens/tokens.service';
import { UsersService, type User } from '../users/users.service';
import { AuthService } from './auth.service';
import { AuthSettingsService } from './auth-settings.service';
import { PasswordService } from './password.service';
import {
  VerificationService,
  type VerificationToken,
} from './verification.service';

const VALID_PASSWORD = 'a perfectly fine passphrase';
const CORRELATION_ID = 'correlation-1';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: '$argon2id$stub',
    role: 'USER',
    emailVerifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('AuthService', () => {
  let users: jest.Mocked<UsersService>;
  let passwords: jest.Mocked<PasswordService>;
  let verification: jest.Mocked<VerificationService>;
  let tokens: jest.Mocked<TokensService>;
  let outbox: jest.Mocked<OutboxService>;
  let settings: jest.Mocked<AuthSettingsService>;
  let service: AuthService;

  const challenge = {
    challengeId: 'challenge-1',
    secret: '123456',
    method: 'otp' as const,
    expiresAt: new Date(Date.now() + 600_000),
  };

  beforeEach(() => {
    users = {
      findByEmail: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      create: jest.fn(),
      markEmailVerified: jest.fn().mockResolvedValue(undefined),
      deleteUnverifiedBefore: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;

    passwords = {
      hash: jest.fn().mockResolvedValue('$argon2id$stub'),
      verify: jest.fn(),
      assertMeetsPolicy: jest.fn(),
    } as unknown as jest.Mocked<PasswordService>;

    verification = {
      issue: jest.fn().mockResolvedValue(challenge),
      rotate: jest.fn().mockResolvedValue(challenge),
      consume: jest.fn(),
      findLiveByUser: jest.fn().mockResolvedValue(null),
      findLiveByChallengeId: jest.fn().mockResolvedValue(null),
      findLiveByRawToken: jest.fn().mockResolvedValue(null),
      assertResendAllowed: jest.fn(),
      deleteExpiredBefore: jest.fn(),
    } as unknown as jest.Mocked<VerificationService>;

    tokens = {
      issuePair: jest.fn().mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: new Date().toISOString(),
      }),
      revokeAllForUser: jest.fn(),
    } as unknown as jest.Mocked<TokensService>;

    outbox = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OutboxService>;

    settings = {
      confirmRegistration: jest.fn().mockReturnValue(false),
      confirmPasswordReset: jest.fn(),
      confirmLogin: jest.fn(),
      confirmationMethod: jest.fn().mockReturnValue('otp'),
    } as unknown as jest.Mocked<AuthSettingsService>;

    service = new AuthService(
      users,
      passwords,
      verification,
      tokens,
      outbox,
      settings,
    );
  });

  const register = (email = 'user@example.com') =>
    service.register({
      email,
      password: VALID_PASSWORD,
      correlationId: CORRELATION_ID,
    });

  describe('register with confirmation off', () => {
    beforeEach(() => {
      settings.confirmRegistration.mockReturnValue(false);
      users.create.mockResolvedValue(
        buildUser({ emailVerifiedAt: new Date() }),
      );
    });

    it('creates an active account and returns a session', async () => {
      const result = await register();

      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: true }),
      );
      expect(result.status).toBe('registered');
      expect(result.tokens).toBeDefined();
    });

    it('issues no challenge and sends no code', async () => {
      await register();

      expect(verification.issue).not.toHaveBeenCalled();
      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_REGISTERED,
        expect.not.objectContaining({ confirmation: expect.anything() }),
        CORRELATION_ID,
      );
    });

    it('normalises the email before it is stored', async () => {
      await register('  User@Example.COM ');

      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'user@example.com' }),
      );
    });

    /**
     * With no confirmation there is no cover story available: the caller
     * either gets a session or does not, so the honest answer is a 409.
     */
    it('answers 409 on a duplicate email', async () => {
      users.findByEmail.mockResolvedValue(buildUser());

      await expect(register()).rejects.toThrow(
        expect.objectContaining({
          code: ERROR_CODES.EMAIL_ALREADY_REGISTERED,
        }),
      );
    });

    it('creates nothing when the password fails the policy', async () => {
      passwords.assertMeetsPolicy.mockImplementation(() => {
        throw new AppError(ERROR_CODES.PASSWORD_TOO_WEAK, 'too weak', 400);
      });

      await expect(register()).rejects.toThrow(AppError);
      expect(users.create).not.toHaveBeenCalled();
    });
  });

  describe('register with confirmation on', () => {
    beforeEach(() => {
      settings.confirmRegistration.mockReturnValue(true);
      users.create.mockResolvedValue(buildUser());
    });

    it('creates an unverified account and withholds the session', async () => {
      const result = await register();

      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: false }),
      );
      expect(result.status).toBe('confirmation_required');
      expect(result.tokens).toBeUndefined();
      expect(tokens.issuePair).not.toHaveBeenCalled();
    });

    it('returns the challenge handle and its expiry', async () => {
      const result = await register();

      expect(result.challengeId).toBe(challenge.challengeId);
      expect(result.expiresAt).toBe(challenge.expiresAt.toISOString());
    });

    it('carries the secret to notification-service through the outbox', async () => {
      await register();

      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_REGISTERED,
        expect.objectContaining({
          confirmation: expect.objectContaining({
            method: 'otp',
            secret: challenge.secret,
          }),
        }),
        CORRELATION_ID,
      );
    });

    /**
     * The point of §8: with confirmation on, an occupied address must be
     * indistinguishable from a free one.
     */
    it('answers exactly as it would for a new address when the account exists and is verified', async () => {
      users.findByEmail.mockResolvedValue(
        buildUser({ emailVerifiedAt: new Date() }),
      );

      const result = await register();

      expect(result.status).toBe('confirmation_required');
      expect(result.challengeId).toEqual(expect.any(String));
      expect(result.expiresAt).toEqual(expect.any(String));
    });

    it('warns the real owner instead of creating a second account', async () => {
      users.findByEmail.mockResolvedValue(
        buildUser({ emailVerifiedAt: new Date() }),
      );

      await register();

      expect(users.create).not.toHaveBeenCalled();
      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_REGISTRATION_ATTEMPTED,
        expect.objectContaining({ email: 'user@example.com' }),
        CORRELATION_ID,
      );
    });

    it('re-sends the code when the existing account was never confirmed', async () => {
      users.findByEmail.mockResolvedValue(buildUser());
      verification.findLiveByUser.mockResolvedValue({
        id: 'token-1',
        challengeId: 'challenge-1',
        method: 'otp',
        expiresAt: challenge.expiresAt,
      } as VerificationToken);

      const result = await register();

      expect(verification.rotate).toHaveBeenCalled();
      expect(result.challengeId).toBe('challenge-1');
      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
        expect.anything(),
        CORRELATION_ID,
      );
    });

    /**
     * Surfacing the resend cooldown here would turn the refusal itself into
     * proof that the address exists.
     */
    it('stays silent when re-registration hits the resend cooldown', async () => {
      users.findByEmail.mockResolvedValue(buildUser());
      verification.findLiveByUser.mockResolvedValue({
        id: 'token-1',
        challengeId: 'challenge-1',
        method: 'otp',
        expiresAt: challenge.expiresAt,
      } as VerificationToken);
      verification.assertResendAllowed.mockImplementation(() => {
        throw new AppError(ERROR_CODES.RESEND_TOO_SOON, 'too soon', 429);
      });

      const result = await register();

      expect(result.status).toBe('confirmation_required');
      expect(verification.rotate).not.toHaveBeenCalled();
    });

    it('hashes the password even when it creates nothing, so timing says nothing', async () => {
      users.findByEmail.mockResolvedValue(
        buildUser({ emailVerifiedAt: new Date() }),
      );

      await register();

      expect(passwords.hash).toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    const liveToken = {
      id: 'token-1',
      userId: 'user-1',
      challengeId: 'challenge-1',
    } as VerificationToken;

    beforeEach(() => {
      verification.findLiveByChallengeId.mockResolvedValue(liveToken);
      verification.consume.mockResolvedValue(liveToken);
      users.findById.mockResolvedValue(buildUser());
    });

    it('marks the address verified and signs the user in', async () => {
      const result = await service.verifyEmail({
        challengeId: 'challenge-1',
        code: '123456',
        correlationId: CORRELATION_ID,
      });

      expect(users.markEmailVerified).toHaveBeenCalledWith('user-1');
      expect(result.status).toBe('verified');
      expect(result.tokens.accessToken).toBe('access');
    });

    it('announces the verification', async () => {
      await service.verifyEmail({
        challengeId: 'challenge-1',
        code: '123456',
        correlationId: CORRELATION_ID,
      });

      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_EMAIL_VERIFIED,
        expect.objectContaining({ userId: 'user-1' }),
        CORRELATION_ID,
      );
    });

    it('accepts a magic-link token with no challenge handle', async () => {
      verification.findLiveByChallengeId.mockResolvedValue(null);
      verification.findLiveByRawToken.mockResolvedValue(liveToken);

      const result = await service.verifyEmail({
        token: 'a-long-random-token',
        correlationId: CORRELATION_ID,
      });

      expect(verification.findLiveByRawToken).toHaveBeenCalledWith(
        'a-long-random-token',
      );
      expect(result.status).toBe('verified');
    });

    it('rejects an unknown challenge', async () => {
      verification.findLiveByChallengeId.mockResolvedValue(null);

      await expect(
        service.verifyEmail({
          challengeId: 'nope',
          code: '123456',
          correlationId: CORRELATION_ID,
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_INVALID }),
      );
    });

    it('rejects a submission carrying neither a code nor a token', async () => {
      await expect(
        service.verifyEmail({
          challengeId: 'challenge-1',
          correlationId: CORRELATION_ID,
        }),
      ).rejects.toThrow(AppError);
      expect(verification.consume).not.toHaveBeenCalled();
    });

    it('does not re-announce a verification for an already verified user', async () => {
      users.findById.mockResolvedValue(
        buildUser({ emailVerifiedAt: new Date() }),
      );

      await service.verifyEmail({
        challengeId: 'challenge-1',
        code: '123456',
        correlationId: CORRELATION_ID,
      });

      expect(users.markEmailVerified).not.toHaveBeenCalled();
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it('fails cleanly when cleanup removed the account mid-flight', async () => {
      users.findById.mockResolvedValue(null);

      await expect(
        service.verifyEmail({
          challengeId: 'challenge-1',
          code: '123456',
          correlationId: CORRELATION_ID,
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_INVALID }),
      );
    });
  });

  describe('resendVerification', () => {
    it('accepts an unknown challenge without saying so', async () => {
      const result = await service.resendVerification({
        challengeId: '00000000-0000-0000-0000-000000000000',
        correlationId: CORRELATION_ID,
      });

      expect(result).toEqual({ status: 'accepted' });
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it('accepts an unknown email without saying so', async () => {
      const result = await service.resendVerification({
        email: 'nobody@example.com',
        correlationId: CORRELATION_ID,
      });

      expect(result).toEqual({ status: 'accepted' });
    });

    it('rotates the code and re-announces it for a pending account', async () => {
      verification.findLiveByChallengeId.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      } as VerificationToken);
      users.findById.mockResolvedValue(buildUser());

      const result = await service.resendVerification({
        challengeId: 'challenge-1',
        correlationId: CORRELATION_ID,
      });

      expect(verification.rotate).toHaveBeenCalled();
      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
        expect.objectContaining({
          confirmation: expect.objectContaining({ secret: challenge.secret }),
        }),
        CORRELATION_ID,
      );
      expect(result).toEqual({ status: 'accepted' });
    });

    it('sends nothing for an account that is already verified', async () => {
      verification.findLiveByChallengeId.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      } as VerificationToken);
      users.findById.mockResolvedValue(
        buildUser({ emailVerifiedAt: new Date() }),
      );

      const result = await service.resendVerification({
        challengeId: 'challenge-1',
        correlationId: CORRELATION_ID,
      });

      expect(verification.rotate).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'accepted' });
    });
  });
});
