/**
 * `@Transactional()` resolves the CLS transaction host at call time, which a
 * unit test has no reason to own — the boundary itself is an integration
 * concern (NON-FUNCTIONAL-REQUIREMENTS.md §7).
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
import { VERIFICATION_TOKEN_TYPES } from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import { OutboxService } from '../outbox/outbox.service';
import { UserRolesService } from '../rbac/user-roles.service';
import { TokensService } from '../tokens/tokens.service';
import { UsersService, type User } from '../users/users.service';
import { AuthSettingsService } from './auth-settings.service';
import { LOCKOUT_MS, LoginService, MAX_FAILED_ATTEMPTS } from './login.service';
import { PasswordService } from './password.service';
import type { VerificationToken } from './verification.service';
import { VerificationService } from './verification.service';

const CORRELATION_ID = 'correlation-1';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: '$argon2id$stub',
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

describe('LoginService', () => {
  let users: jest.Mocked<UsersService>;
  let passwords: jest.Mocked<PasswordService>;
  let verification: jest.Mocked<VerificationService>;
  let tokens: jest.Mocked<TokensService>;
  let outbox: jest.Mocked<OutboxService>;
  let settings: jest.Mocked<AuthSettingsService>;
  let userRoles: jest.Mocked<UserRolesService>;
  let service: LoginService;

  const challenge = {
    challengeId: 'challenge-1',
    secret: '123456',
    method: 'otp' as const,
    expiresAt: new Date(Date.now() + 600_000),
  };

  beforeEach(() => {
    users = {
      findByEmail: jest.fn().mockResolvedValue(buildUser()),
      findById: jest.fn().mockResolvedValue(buildUser()),
      recordLoginFailure: jest.fn().mockResolvedValue(undefined),
      lockLogin: jest.fn().mockResolvedValue(undefined),
      resetLoginFailures: jest.fn().mockResolvedValue(undefined),
      recordSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<UsersService>;

    passwords = {
      verify: jest.fn().mockResolvedValue(true),
      burnVerificationTime: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PasswordService>;

    verification = {
      issue: jest.fn().mockResolvedValue(challenge),
      rotate: jest.fn().mockResolvedValue(challenge),
      consume: jest.fn(),
      findLiveByChallengeId: jest.fn().mockResolvedValue(null),
      findLiveByRawToken: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<VerificationService>;

    tokens = {
      issuePair: jest.fn().mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: new Date().toISOString(),
        refreshTokenExpiresAt: new Date().toISOString(),
      }),
    } as unknown as jest.Mocked<TokensService>;

    outbox = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OutboxService>;

    settings = {
      confirmLogin: jest.fn().mockReturnValue(false),
      maxFailedLoginAttempts: jest.fn().mockReturnValue(MAX_FAILED_ATTEMPTS),
      loginLockoutMs: jest.fn().mockReturnValue(LOCKOUT_MS),
    } as unknown as jest.Mocked<AuthSettingsService>;

    userRoles = {
      namesFor: jest.fn().mockResolvedValue(['USER']),
    } as unknown as jest.Mocked<UserRolesService>;

    service = new LoginService(
      users,
      passwords,
      verification,
      tokens,
      outbox,
      settings,
      userRoles,
    );
  });

  const login = (password = 'a perfectly fine passphrase') =>
    service.login({
      email: 'user@example.com',
      password,
      correlationId: CORRELATION_ID,
    });

  describe('with confirmation off', () => {
    it('returns a session for a correct password', async () => {
      const result = await login();

      expect(result.status).toBe('authenticated');
      expect(result.tokens?.accessToken).toBe('access');
    });

    it('signs the token with the roles the user holds', async () => {
      userRoles.namesFor.mockResolvedValue(['USER', 'ADMIN']);

      await login();

      expect(tokens.issuePair).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        ['USER', 'ADMIN'],
      );
    });

    /**
     * One write, not two: the statement that records the login is the same one
     * that clears the brute-force counter.
     */
    it('records the login and clears the failure count together', async () => {
      await login();

      expect(users.recordSuccessfulLogin).toHaveBeenCalledWith('user-1');
      expect(users.resetLoginFailures).not.toHaveBeenCalled();
    });

    it('issues no challenge and sends no mail', async () => {
      await login();

      expect(verification.issue).not.toHaveBeenCalled();
      expect(outbox.publish).not.toHaveBeenCalled();
    });
  });

  describe('refusals', () => {
    it('answers identically for an unknown address and a wrong password', async () => {
      users.findByEmail.mockResolvedValue(null);
      const unknown = await login().catch((error: AppError) => error);

      users.findByEmail.mockResolvedValue(buildUser());
      passwords.verify.mockResolvedValue(false);
      const wrong = await login().catch((error: AppError) => error);

      expect((unknown as AppError).code).toBe(ERROR_CODES.INVALID_CREDENTIALS);
      expect((unknown as AppError).message).toBe((wrong as AppError).message);
      expect((unknown as AppError).httpStatus).toBe(
        (wrong as AppError).httpStatus,
      );
    });

    /**
     * Returning early on a missed lookup makes the miss measurably faster than
     * a hit, which is an account-existence oracle no wording can hide.
     */
    it('spends verification time even when the account does not exist', async () => {
      users.findByEmail.mockResolvedValue(null);

      await expect(login()).rejects.toThrow(AppError);
      expect(passwords.burnVerificationTime).toHaveBeenCalled();
    });

    it('refuses an unverified account, and says so', async () => {
      users.findByEmail.mockResolvedValue(buildUser({ emailVerifiedAt: null }));

      await expect(login()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.EMAIL_NOT_VERIFIED }),
      );
      expect(tokens.issuePair).not.toHaveBeenCalled();
    });

    it('does not count a correct password as a failure', async () => {
      users.findByEmail.mockResolvedValue(buildUser({ emailVerifiedAt: null }));

      await expect(login()).rejects.toThrow(AppError);
      expect(users.recordLoginFailure).not.toHaveBeenCalled();
    });
  });

  describe('lockout', () => {
    it('counts a wrong password', async () => {
      passwords.verify.mockResolvedValue(false);

      await expect(login()).rejects.toThrow(AppError);
      expect(users.recordLoginFailure).toHaveBeenCalledWith('user-1');
    });

    it('locks the account on the attempt that reaches the cap', async () => {
      users.findByEmail.mockResolvedValue(
        buildUser({ failedLoginAttempts: MAX_FAILED_ATTEMPTS - 1 }),
      );
      passwords.verify.mockResolvedValue(false);

      await expect(login()).rejects.toThrow(AppError);
      expect(users.lockLogin).toHaveBeenCalledWith('user-1', expect.any(Date));
      expect(users.recordLoginFailure).not.toHaveBeenCalled();
    });

    it('locks for the configured window', async () => {
      users.findByEmail.mockResolvedValue(
        buildUser({ failedLoginAttempts: MAX_FAILED_ATTEMPTS - 1 }),
      );
      passwords.verify.mockResolvedValue(false);

      await expect(login()).rejects.toThrow(AppError);

      const until = users.lockLogin.mock.calls[0][1];

      expect(until.getTime() - Date.now()).toBeGreaterThan(LOCKOUT_MS - 5_000);
      expect(until.getTime() - Date.now()).toBeLessThanOrEqual(LOCKOUT_MS);
    });

    /** Refused before the password is even checked. */
    it('refuses a locked account and says how long to wait', async () => {
      users.findByEmail.mockResolvedValue(
        buildUser({ lockedUntil: new Date(Date.now() + 60_000) }),
      );

      const error = (await login().catch((e: AppError) => e)) as AppError;

      expect(error.code).toBe(ERROR_CODES.ACCOUNT_LOCKED);
      expect(error.details).toEqual(
        expect.objectContaining({ retryAfterSeconds: expect.any(Number) }),
      );
      expect(passwords.verify).not.toHaveBeenCalled();
    });

    it('lets a lapsed lock through', async () => {
      users.findByEmail.mockResolvedValue(
        buildUser({
          lockedUntil: new Date(Date.now() - 1),
          failedLoginAttempts: MAX_FAILED_ATTEMPTS,
        }),
      );

      await expect(login()).resolves.toEqual(
        expect.objectContaining({ status: 'authenticated' }),
      );
    });
  });

  describe('with confirmation on', () => {
    beforeEach(() => settings.confirmLogin.mockReturnValue(true));

    it('withholds the session and returns a challenge', async () => {
      const result = await login();

      expect(result.status).toBe('confirmation_required');
      expect(result.tokens).toBeUndefined();
      expect(tokens.issuePair).not.toHaveBeenCalled();
      expect(result.challengeId).toBe(challenge.challengeId);
    });

    it('issues a login challenge, not an email-verification one', async () => {
      await login();

      expect(verification.issue).toHaveBeenCalledWith(
        'user-1',
        VERIFICATION_TOKEN_TYPES.LOGIN_CONFIRMATION,
      );
    });

    it('carries the secret and the device to the mailer', async () => {
      await service.login({
        email: 'user@example.com',
        password: 'a perfectly fine passphrase',
        correlationId: CORRELATION_ID,
        session: { userAgent: 'Firefox', ip: '203.0.113.4' },
      });

      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_LOGIN_CONFIRMATION_REQUESTED,
        expect.objectContaining({
          secret: challenge.secret,
          userAgent: 'Firefox',
          ip: '203.0.113.4',
        }),
        CORRELATION_ID,
      );
    });
  });

  describe('confirmLogin', () => {
    const loginToken = {
      id: 'token-1',
      userId: 'user-1',
      type: VERIFICATION_TOKEN_TYPES.LOGIN_CONFIRMATION,
    } as VerificationToken;

    beforeEach(() => {
      verification.findLiveByChallengeId.mockResolvedValue(loginToken);
      verification.consume.mockResolvedValue(loginToken);
    });

    it('issues a session once the code checks out', async () => {
      const result = await service.confirmLogin({
        challengeId: 'challenge-1',
        code: '123456',
        correlationId: CORRELATION_ID,
      });

      expect(result.status).toBe('authenticated');
      expect(result.tokens.accessToken).toBe('access');
    });

    it('accepts a magic-link token with no challenge handle', async () => {
      verification.findLiveByChallengeId.mockResolvedValue(null);
      verification.findLiveByRawToken.mockResolvedValue(loginToken);

      await expect(
        service.confirmLogin({
          token: 'a-long-random-token',
          correlationId: CORRELATION_ID,
        }),
      ).resolves.toEqual(expect.objectContaining({ status: 'authenticated' }));
    });

    /**
     * Otherwise a registration code — a weaker challenge, with a 24-hour link
     * TTL — would complete a login.
     */
    it('refuses a challenge of the wrong type', async () => {
      verification.findLiveByChallengeId.mockResolvedValue({
        ...loginToken,
        type: VERIFICATION_TOKEN_TYPES.EMAIL_VERIFICATION,
      } as VerificationToken);

      await expect(
        service.confirmLogin({
          challengeId: 'challenge-1',
          code: '123456',
          correlationId: CORRELATION_ID,
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_INVALID }),
      );
      expect(verification.consume).not.toHaveBeenCalled();
    });

    it('refuses an unknown challenge', async () => {
      verification.findLiveByChallengeId.mockResolvedValue(null);

      await expect(
        service.confirmLogin({
          challengeId: 'nope',
          code: '123456',
          correlationId: CORRELATION_ID,
        }),
      ).rejects.toThrow(AppError);
    });

    it('refuses to complete a login into an account locked meanwhile', async () => {
      users.findById.mockResolvedValue(
        buildUser({ lockedUntil: new Date(Date.now() + 60_000) }),
      );

      await expect(
        service.confirmLogin({
          challengeId: 'challenge-1',
          code: '123456',
          correlationId: CORRELATION_ID,
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.ACCOUNT_LOCKED }),
      );
    });
  });

  describe('resendConfirmation', () => {
    it('rotates the code and re-announces it', async () => {
      verification.findLiveByChallengeId.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
        type: VERIFICATION_TOKEN_TYPES.LOGIN_CONFIRMATION,
      } as VerificationToken);

      await expect(
        service.resendConfirmation('challenge-1', CORRELATION_ID),
      ).resolves.toEqual({ status: 'accepted' });

      expect(verification.rotate).toHaveBeenCalled();
      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_LOGIN_CONFIRMATION_REQUESTED,
        expect.objectContaining({ secret: challenge.secret }),
        CORRELATION_ID,
      );
    });

    it('accepts an unknown challenge without saying so', async () => {
      await expect(
        service.resendConfirmation('nope', CORRELATION_ID),
      ).resolves.toEqual({ status: 'accepted' });
      expect(outbox.publish).not.toHaveBeenCalled();
    });
  });
});
