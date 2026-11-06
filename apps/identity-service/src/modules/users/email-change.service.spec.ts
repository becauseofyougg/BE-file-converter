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

import { Prisma } from '@prisma-clients/identity';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { DOMAIN_EVENTS } from '@contracts/events/domain.events';
import { VERIFICATION_TOKEN_TYPES } from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import type { VerificationToken } from '../auth/verification.service';
import { VerificationService } from '../auth/verification.service';
import { OutboxService } from '../outbox/outbox.service';
import { EmailChangeService } from './email-change.service';
import { UsersService, type User } from './users.service';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: VIEWER,
    email: 'old@example.com',
    displayName: null,
    passwordHash: '$argon2id$stub',
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    deletedAt: null,
    photoKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

function buildToken(overrides: Partial<VerificationToken> = {}) {
  return {
    id: 'token-1',
    userId: VIEWER,
    type: VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE,
    challengeId: 'challenge-1',
    tokenHash: 'a'.repeat(64),
    method: 'otp',
    newEmail: 'new@example.com',
    expiresAt: new Date(Date.now() + 600_000),
    usedAt: null,
    attempts: 0,
    resendCount: 0,
    lastSentAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as VerificationToken;
}

describe('EmailChangeService', () => {
  let users: jest.Mocked<UsersService>;
  let verification: jest.Mocked<VerificationService>;
  let outbox: jest.Mocked<OutboxService>;
  let service: EmailChangeService;
  let warn: jest.SpyInstance;

  const challenge = {
    challengeId: 'challenge-1',
    secret: '123456',
    method: 'otp' as const,
    expiresAt: new Date(Date.now() + 600_000),
  };

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(buildUser()),
      isEmailTaken: jest.fn().mockResolvedValue(false),
      changeEmail: jest
        .fn()
        .mockResolvedValue(buildUser({ email: 'new@example.com' })),
    } as unknown as jest.Mocked<UsersService>;

    verification = {
      issue: jest.fn().mockResolvedValue(challenge),
      rotate: jest.fn().mockResolvedValue(challenge),
      findLiveByUser: jest.fn().mockResolvedValue(null),
      consume: jest.fn().mockResolvedValue(undefined),
      findLiveByChallengeId: jest.fn().mockResolvedValue(buildToken()),
      findLiveByRawToken: jest.fn().mockResolvedValue(buildToken()),
    } as unknown as jest.Mocked<VerificationService>;

    outbox = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OutboxService>;

    service = new EmailChangeService(users, verification, outbox);
    warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
  });

  const start = (newEmail = 'new@example.com', targetUserId = VIEWER) =>
    service.start({
      targetUserId,
      viewerUserId: VIEWER,
      newEmail,
      correlationId: 'correlation-1',
    });

  describe('start', () => {
    it('issues a challenge that carries the address being claimed', async () => {
      const result = await start();

      expect(result).toMatchObject({
        requiresConfirmation: true,
        challengeId: 'challenge-1',
      });
      // On the row, not re-submitted later: the address that gets proved is
      // necessarily the one that gets applied.
      expect(verification.issue).toHaveBeenCalledWith(
        VIEWER,
        VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE,
        'new@example.com',
      );
    });

    it('mails the address being claimed, not the current one', async () => {
      await start();

      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_EMAIL_CHANGE_REQUESTED,
        expect.objectContaining({ newEmail: 'new@example.com' }),
        'correlation-1',
      );
    });

    /** No permission opens this to anyone else — an admin has the direct path. */
    it('refuses to start a change for another account', async () => {
      await expect(start('new@example.com', OTHER)).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.FORBIDDEN }),
      );
      expect(verification.issue).not.toHaveBeenCalled();
    });

    it('refuses an address another account holds, plainly', async () => {
      users.isEmailTaken.mockResolvedValue(true);

      await expect(start()).rejects.toThrow(
        expect.objectContaining({
          code: ERROR_CODES.EMAIL_IN_USE,
          httpStatus: 409,
        }),
      );
    });

    it('refuses an address the account already has', async () => {
      await expect(start('old@example.com')).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.VALIDATION_FAILED }),
      );
    });

    it('normalises the address before anything else looks at it', async () => {
      await start('  NEW@Example.COM  ');

      expect(users.isEmailTaken).toHaveBeenCalledWith(
        'new@example.com',
        VIEWER,
      );
    });

    /**
     * An erased account keeps a live access token for up to fifteen minutes;
     * let through, it would write a real address back onto the anonymised row.
     */
    it('refuses an erased account, and issues nothing', async () => {
      users.findById.mockResolvedValue(buildUser({ deletedAt: new Date() }));

      await expect(start()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.USER_NOT_FOUND }),
      );
      expect(verification.issue).not.toHaveBeenCalled();
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    /**
     * Starting over must not be a way around the resend limits: a fresh
     * challenge per call reset them, and every call mailed a new code.
     */
    it('rotates a pending challenge onto the new address instead of opening another', async () => {
      const live = buildToken({ newEmail: 'first@example.com' });
      verification.findLiveByUser.mockResolvedValue(live);

      await start('second@example.com');

      expect(verification.rotate).toHaveBeenCalledWith(
        live,
        'second@example.com',
      );
      expect(verification.issue).not.toHaveBeenCalled();
    });

    it('refuses to start over inside the resend interval, and logs it', async () => {
      verification.findLiveByUser.mockResolvedValue(buildToken());
      verification.rotate.mockRejectedValue(
        new AppError(ERROR_CODES.RESEND_TOO_SOON, 'too soon', 429),
      );

      await expect(start()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.RESEND_TOO_SOON }),
      );
      expect(outbox.publish).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'users.email_change.requested',
          outcome: 'resend_too_soon',
        }),
      );
    });

    it.each([
      [
        'email_in_use',
        () => users.isEmailTaken.mockResolvedValue(true),
        'new@example.com',
      ],
      ['same_address', () => undefined, 'old@example.com'],
    ] as const)('logs a %s refusal', async (outcome, arrange, address) => {
      arrange();

      await expect(start(address)).rejects.toThrow(AppError);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'users.email_change.requested',
          outcome,
        }),
      );
    });
  });

  describe('confirm', () => {
    const confirm = (
      input: Partial<{ challengeId: string; code: string; token: string }> = {
        challengeId: 'challenge-1',
        code: '123456',
      },
    ) =>
      service.confirm({
        targetUserId: VIEWER,
        correlationId: 'correlation-1',
        ...input,
      });

    it('applies the address the challenge carried', async () => {
      await expect(confirm()).resolves.toMatchObject({
        status: 'email_changed',
        email: 'new@example.com',
      });
      expect(users.changeEmail).toHaveBeenCalledWith(VIEWER, 'new@example.com');
    });

    it('accepts a bare link token, with no session involved', async () => {
      await expect(confirm({ token: 'a'.repeat(43) })).resolves.toMatchObject({
        status: 'email_changed',
      });
    });

    /**
     * Without the type check, an email-verification code — a weaker challenge
     * with a day-long link — would move the account to whatever address the row
     * happened to name.
     */
    it('refuses a challenge issued for something else', async () => {
      verification.findLiveByChallengeId.mockResolvedValue(
        buildToken({
          type: VERIFICATION_TOKEN_TYPES.EMAIL_VERIFICATION,
        } as Partial<VerificationToken>),
      );

      await expect(confirm()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_INVALID }),
      );
      expect(users.changeEmail).not.toHaveBeenCalled();
    });

    it('refuses when the path names a different account', async () => {
      verification.findLiveByChallengeId.mockResolvedValue(
        buildToken({ userId: OTHER } as Partial<VerificationToken>),
      );

      await expect(confirm()).rejects.toThrow(AppError);
      expect(users.changeEmail).not.toHaveBeenCalled();
    });

    /** Somebody may have claimed the address during the ten minutes. */
    it('re-checks that the address is still free', async () => {
      users.isEmailTaken.mockResolvedValue(true);

      await expect(confirm()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.EMAIL_IN_USE }),
      );
      expect(users.changeEmail).not.toHaveBeenCalled();
    });

    it('notifies the address that lost the account, with no actor', async () => {
      await confirm();

      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_EMAIL_CHANGED,
        expect.objectContaining({
          previousEmail: 'old@example.com',
          newEmail: 'new@example.com',
        }),
        'correlation-1',
      );
    });

    it('consumes the challenge before touching the account', async () => {
      await confirm();

      expect(verification.consume).toHaveBeenCalled();
      expect(verification.consume.mock.invocationCallOrder[0]).toBeLessThan(
        users.changeEmail.mock.invocationCallOrder[0],
      );
    });

    it('needs a code or a token, not just a handle', async () => {
      await expect(confirm({ challengeId: 'challenge-1' })).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.VALIDATION_FAILED }),
      );
    });

    it('refuses to move an account erased since the challenge was issued', async () => {
      users.findById.mockResolvedValue(buildUser({ deletedAt: new Date() }));

      await expect(confirm()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_INVALID }),
      );
      expect(users.changeEmail).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'users.email_change.failed',
          reason: 'account_removed',
        }),
      );
    });

    /** Two claims racing past the pre-check; the unique index catches one. */
    it('answers 409, not 500, when another account took the address meanwhile', async () => {
      users.changeEmail.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(confirm()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.EMAIL_IN_USE }),
      );
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown_challenge', null],
      [
        'wrong_owner',
        buildToken({ userId: OTHER } as Partial<VerificationToken>),
      ],
      [
        'wrong_type',
        buildToken({
          type: VERIFICATION_TOKEN_TYPES.EMAIL_VERIFICATION,
        } as Partial<VerificationToken>),
      ],
    ])('logs a %s refusal', async (reason, found) => {
      verification.findLiveByChallengeId.mockResolvedValue(found);

      await expect(confirm()).rejects.toThrow(AppError);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.verification.failed',
          type: VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE,
          reason,
        }),
      );
    });
  });
});
