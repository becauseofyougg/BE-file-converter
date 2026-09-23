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
import { AppError } from '@core/errors/app-error';
import { OutboxService } from '../outbox/outbox.service';
import { RbacConfigService } from '../rbac/rbac-config.service';
import { ProfileUpdateService } from './profile-update.service';
import { ProfileService } from './profile.service';
import { UsersService, type User } from './users.service';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: TARGET,
    email: 'target@example.com',
    displayName: 'Target',
    passwordHash: '$argon2id$stub',
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    photoKey: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

describe('ProfileUpdateService', () => {
  let users: jest.Mocked<UsersService>;
  let profiles: jest.Mocked<ProfileService>;
  let rbac: jest.Mocked<RbacConfigService>;
  let outbox: jest.Mocked<OutboxService>;
  let service: ProfileUpdateService;

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(buildUser()),
      update: jest.fn().mockResolvedValue(buildUser()),
      isEmailTaken: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<UsersService>;

    profiles = {
      projectFor: jest.fn().mockResolvedValue({ id: TARGET }),
    } as unknown as jest.Mocked<ProfileService>;

    rbac = {
      check: jest
        .fn()
        .mockResolvedValue({ allowed: false, reason: 'no_grant' }),
    } as unknown as jest.Mocked<RbacConfigService>;

    outbox = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OutboxService>;

    service = new ProfileUpdateService(users, profiles, rbac, outbox);
  });

  const patchSelf = (patch: Record<string, unknown>) =>
    service.updateProfile({
      targetUserId: VIEWER,
      viewerUserId: VIEWER,
      viewerRoles: ['USER'],
      patch,
      correlationId: 'correlation-1',
    });

  const patchOther = (patch: Record<string, unknown>, roles = ['SUPPORT']) =>
    service.updateProfile({
      targetUserId: TARGET,
      viewerUserId: VIEWER,
      viewerRoles: roles,
      patch,
      correlationId: 'correlation-1',
    });

  describe('self', () => {
    beforeEach(() => {
      users.findById.mockResolvedValue(buildUser({ id: VIEWER }));
      users.update.mockResolvedValue(buildUser({ id: VIEWER }));
    });

    it('changes a name without consulting RBAC', async () => {
      await patchSelf({ displayName: 'New Name' });

      expect(users.update).toHaveBeenCalledWith(VIEWER, {
        displayName: 'New Name',
      });
      expect(rbac.check).not.toHaveBeenCalled();
    });

    it('trims a name, and treats a blank one as clearing it', async () => {
      await patchSelf({ displayName: '  Ada Lovelace  ' });

      expect(users.update).toHaveBeenCalledWith(VIEWER, {
        displayName: 'Ada Lovelace',
      });

      // Otherwise a profile renders blank without being null — two states that
      // look identical and behave differently.
      await patchSelf({ displayName: '   ' });

      expect(users.update).toHaveBeenLastCalledWith(VIEWER, {
        displayName: null,
      });
    });

    it('leaves a field the patch did not mention alone', async () => {
      await patchSelf({});

      expect(users.update).toHaveBeenCalledWith(VIEWER, {});
    });

    /**
     * The requirement's central rule: moving an account to a new address has to
     * be proved against that address, so this route refuses and points at the
     * one that can.
     */
    it('refuses to change its own email here', async () => {
      const error = (await patchSelf({
        email: 'new@example.com',
      }).catch((caught: AppError) => caught)) as AppError;

      expect(error.code).toBe(ERROR_CODES.FIELD_NOT_WRITABLE);
      expect(error.httpStatus).toBe(403);
      expect(error.message).toContain('email-change');
      expect(users.update).not.toHaveBeenCalled();
    });
  });

  describe('someone else', () => {
    it('refuses a viewer without users@update', async () => {
      await expect(patchOther({ displayName: 'x' })).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.FORBIDDEN }),
      );
    });

    it('checks the update permission, not the read one', async () => {
      rbac.check.mockResolvedValue({ allowed: true });

      await patchOther({ displayName: 'x' });

      expect(rbac.check).toHaveBeenCalledWith(['SUPPORT'], 'users', 'update');
    });

    /**
     * Same ordering as the read path: a refusal must not depend on whether the
     * id exists, or it becomes a way to find out.
     */
    it('does not look the target up when the viewer may not', async () => {
      await expect(patchOther({ displayName: 'x' })).rejects.toThrow(AppError);

      expect(users.findById).not.toHaveBeenCalled();
    });

    it('lets an administrator set an email directly', async () => {
      rbac.check.mockResolvedValue({ allowed: true });
      users.update.mockResolvedValue(buildUser({ email: 'new@example.com' }));

      await patchOther({ email: 'new@example.com' });

      expect(users.update).toHaveBeenCalledWith(TARGET, {
        email: 'new@example.com',
      });
    });

    /** The only way the old mailbox learns its account has been moved. */
    it('tells the address that just lost the account', async () => {
      rbac.check.mockResolvedValue({ allowed: true });
      users.update.mockResolvedValue(buildUser({ email: 'new@example.com' }));

      await patchOther({ email: 'new@example.com' });

      expect(outbox.publish).toHaveBeenCalledWith(
        DOMAIN_EVENTS.USER_EMAIL_CHANGED,
        expect.objectContaining({
          previousEmail: 'target@example.com',
          newEmail: 'new@example.com',
          actorUserId: VIEWER,
        }),
        'correlation-1',
      );
    });

    it('refuses an address another account already holds', async () => {
      rbac.check.mockResolvedValue({ allowed: true });
      users.isEmailTaken.mockResolvedValue(true);

      await expect(patchOther({ email: 'taken@example.com' })).rejects.toThrow(
        expect.objectContaining({
          code: ERROR_CODES.EMAIL_IN_USE,
          httpStatus: 409,
        }),
      );
      expect(users.update).not.toHaveBeenCalled();
    });

    it('sends no notice when nothing about the address changed', async () => {
      rbac.check.mockResolvedValue({ allowed: true });

      await patchOther({ displayName: 'x' });

      expect(outbox.publish).not.toHaveBeenCalled();
    });
  });

  describe('default-deny', () => {
    /**
     * Refused, not ignored. Dropping it silently would leave the client
     * believing a change it can see in its own form actually happened.
     */
    it('names the fields it would not write', async () => {
      const error = (await patchSelf({
        displayName: 'ok',
        email: 'new@example.com',
      }).catch((caught: AppError) => caught)) as AppError;

      expect(error.details).toEqual({ fields: ['email'] });
      // Nothing at all is applied — a patch is one change, not a best effort.
      expect(users.update).not.toHaveBeenCalled();
    });
  });
});
