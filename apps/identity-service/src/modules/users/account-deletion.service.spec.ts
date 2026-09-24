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
import { anonymizedEmail } from '@contracts/messages/users.messages';
import { AppError } from '@core/errors/app-error';
import type { VerificationToken } from '../auth/verification.service';
import { VerificationService } from '../auth/verification.service';
import { OutboxService } from '../outbox/outbox.service';
import { RbacConfigService } from '../rbac/rbac-config.service';
import { AccountDeletionService } from './account-deletion.service';
import { UsersService, type User } from './users.service';

const SELF = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: SELF,
    email: 'user@example.com',
    displayName: 'User',
    passwordHash: '$argon2id$stub',
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    deletedAt: null,
    photoKey: 'profile-photos/user.jpg',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

function buildToken(overrides: Partial<VerificationToken> = {}) {
  return {
    id: 'token-1',
    userId: SELF,
    type: VERIFICATION_TOKEN_TYPES.ACCOUNT_DELETION,
    challengeId: 'challenge-1',
    tokenHash: 'a'.repeat(64),
    method: 'otp',
    newEmail: null,
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

describe('AccountDeletionService', () => {
  let users: jest.Mocked<UsersService>;
  let verification: jest.Mocked<VerificationService>;
  let rbac: jest.Mocked<RbacConfigService>;
  let outbox: jest.Mocked<OutboxService>;
  let service: AccountDeletionService;

  const challenge = {
    challengeId: 'challenge-1',
    secret: '123456',
    method: 'otp' as const,
    expiresAt: new Date(Date.now() + 600_000),
  };

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(buildUser()),
      anonymize: jest
        .fn()
        .mockResolvedValue(buildUser({ deletedAt: new Date() })),
      invalidateChallenges: jest.fn().mockResolvedValue(1),
      clearRoles: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<UsersService>;

    verification = {
      issue: jest.fn().mockResolvedValue(challenge),
      consume: jest.fn().mockResolvedValue(undefined),
      findLiveByChallengeId: jest.fn().mockResolvedValue(buildToken()),
      findLiveByRawToken: jest.fn().mockResolvedValue(buildToken()),
    } as unknown as jest.Mocked<VerificationService>;

    rbac = {
      check: jest
        .fn()
        .mockResolvedValue({ allowed: false, reason: 'no_grant' }),
    } as unknown as jest.Mocked<RbacConfigService>;

    outbox = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OutboxService>;

    service = new AccountDeletionService(users, verification, rbac, outbox);
  });

  const deleteSelf = () =>
    service.requestDeletion({
      targetUserId: SELF,
      viewerUserId: SELF,
      viewerRoles: ['USER'],
      correlationId: 'correlation-1',
    });

  const deleteOther = (roles = ['ADMIN']) =>
    service.requestDeletion({
      targetUserId: TARGET,
      viewerUserId: SELF,
      viewerRoles: roles,
      reason: 'support request',
      correlationId: 'correlation-1',
    });

  describe('self', () => {
    /**
     * The one irreversible thing the API does. A session found on an unlocked
     * laptop must not be enough on its own.
     */
    it('erases nothing until the address is proved', async () => {
      const result = await deleteSelf();

      expect(result).toMatchObject({
        status: 'confirmation_required',
        challengeId: 'challenge-1',
      });
      expect(users.anonymize).not.toHaveBeenCalled();
    });

    it('sends the code to the account, which is the second factor', async () => {
      await deleteSelf();

      expect(verification.issue).toHaveBeenCalledWith(
        SELF,
        VERIFICATION_TOKEN_TYPES.ACCOUNT_DELETION,
      );
      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_DELETION_REQUESTED,
        expect.objectContaining({ email: 'user@example.com' }),
        'correlation-1',
      );
    });

    it('needs no permission — it is their own account', async () => {
      await deleteSelf();

      expect(rbac.check).not.toHaveBeenCalled();
    });
  });

  describe('administrator', () => {
    beforeEach(() => {
      users.findById.mockResolvedValue(buildUser({ id: TARGET }));
      users.anonymize.mockResolvedValue(
        buildUser({ id: TARGET, deletedAt: new Date() }),
      );
    });

    it('erases immediately, with no challenge', async () => {
      rbac.check.mockResolvedValue({ allowed: true });

      await expect(deleteOther()).resolves.toMatchObject({
        status: 'deleted',
        userId: TARGET,
      });
      expect(verification.issue).not.toHaveBeenCalled();
      expect(users.anonymize).toHaveBeenCalledWith(TARGET);
    });

    it('checks users@delete, not read or update', async () => {
      rbac.check.mockResolvedValue({ allowed: true });

      await deleteOther(['ADMIN']);

      expect(rbac.check).toHaveBeenCalledWith(['ADMIN'], 'users', 'delete');
    });

    it('refuses a viewer without it', async () => {
      await expect(deleteOther(['USER'])).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.FORBIDDEN }),
      );
      expect(users.anonymize).not.toHaveBeenCalled();
    });

    /** Same ordering as every other route: a refusal must not reveal existence. */
    it('does not look the target up when the viewer may not', async () => {
      await expect(deleteOther(['USER'])).rejects.toThrow(AppError);

      expect(users.findById).not.toHaveBeenCalled();
    });

    it('records who did it, so the notice can say so', async () => {
      rbac.check.mockResolvedValue({ allowed: true });

      await deleteOther();

      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_DELETED,
        expect.objectContaining({ actorUserId: SELF }),
        'correlation-1',
      );
    });
  });

  describe('the erasure itself', () => {
    const confirm = () =>
      service.confirmDeletion({
        targetUserId: SELF,
        viewerUserId: SELF,
        challengeId: 'challenge-1',
        code: '123456',
        correlationId: 'correlation-1',
      });

    it('strips roles and spends every live code, clearing any typed address', async () => {
      await confirm();

      expect(users.invalidateChallenges).toHaveBeenCalledWith(SELF);
      expect(users.clearRoles).toHaveBeenCalledWith(SELF);
      expect(users.anonymize).toHaveBeenCalledWith(SELF);
    });

    /**
     * The address and the key ride along *because* they have just been
     * destroyed — a consumer that went looking for them afterwards would find
     * an emptied row.
     */
    it('carries what was erased, so downstream can finish the job', async () => {
      await confirm();

      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_DELETED,
        expect.objectContaining({
          userId: SELF,
          email: 'user@example.com',
          photoKey: 'profile-photos/user.jpg',
          actorUserId: undefined,
        }),
        'correlation-1',
      );
    });

    it('refuses a challenge issued for something else', async () => {
      verification.findLiveByChallengeId.mockResolvedValue(
        buildToken({
          type: VERIFICATION_TOKEN_TYPES.LOGIN_CONFIRMATION,
        } as Partial<VerificationToken>),
      );

      await expect(confirm()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.CONFIRMATION_INVALID }),
      );
      expect(users.anonymize).not.toHaveBeenCalled();
    });

    /** The session has to belong to the account being erased. */
    it('refuses a challenge belonging to someone else', async () => {
      verification.findLiveByChallengeId.mockResolvedValue(
        buildToken({ userId: TARGET } as Partial<VerificationToken>),
      );

      await expect(confirm()).rejects.toThrow(AppError);
      expect(users.anonymize).not.toHaveBeenCalled();
    });
  });

  describe('idempotence', () => {
    /**
     * §1.6. The row survives its own erasure, so a repeat call finds it — and
     * has to treat it as absent, or a deleted account could be deleted twice
     * and publish a second `user.deleted`.
     */
    it('treats an already-erased account as not found', async () => {
      users.findById.mockResolvedValue(buildUser({ deletedAt: new Date() }));

      await expect(deleteSelf()).rejects.toThrow(
        expect.objectContaining({
          code: ERROR_CODES.USER_NOT_FOUND,
          httpStatus: 404,
        }),
      );
      expect(users.anonymize).not.toHaveBeenCalled();
      expect(outbox.publish).not.toHaveBeenCalled();
    });
  });

  describe('anonymizedEmail', () => {
    it('is unique per account and cannot be routed', () => {
      expect(anonymizedEmail(SELF)).toBe(`deleted-${SELF}@invalid`);
      expect(anonymizedEmail(SELF)).not.toBe(anonymizedEmail(TARGET));
    });
  });
});
