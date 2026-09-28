import type { TransactionHost } from '@nestjs-cls/transactional';

import { anonymizedEmail } from '@contracts/messages/users.messages';

import {
  UsersService,
  isDeleted,
  isEmailVerified,
  normalizeEmail,
} from './users.service';

const USER_ID = 'user-1';

describe('normalizeEmail', () => {
  /**
   * Normalising here rather than at each call site is what keeps `User@x.com`
   * and `user@x.com` one account.
   */
  it.each([
    ['  Ada@Example.COM  ', 'ada@example.com'],
    ['ada@example.com', 'ada@example.com'],
    ['\tADA@EXAMPLE.COM\n', 'ada@example.com'],
  ])('turns %j into %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
});

describe('isEmailVerified', () => {
  it('is true once the timestamp is set', () => {
    expect(isEmailVerified({ emailVerifiedAt: new Date() })).toBe(true);
    expect(isEmailVerified({ emailVerifiedAt: null })).toBe(false);
  });
});

describe('isDeleted', () => {
  it('is true once the row is a tombstone', () => {
    expect(isDeleted({ deletedAt: new Date() })).toBe(true);
    expect(isDeleted({ deletedAt: null })).toBe(false);
  });
});

describe('UsersService', () => {
  let user: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    deleteMany: jest.Mock;
  };
  let verificationToken: { updateMany: jest.Mock };
  let userRoleAssignment: { deleteMany: jest.Mock };
  let service: UsersService;

  const args = (mock: jest.Mock, call = 0) =>
    mock.mock.calls[call][0] as Record<string, unknown>;

  beforeEach(() => {
    user = {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: USER_ID }),
      update: jest.fn().mockResolvedValue({ id: USER_ID }),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    };
    verificationToken = {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    };
    userRoleAssignment = {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };

    service = new UsersService({
      tx: { user, verificationToken, userRoleAssignment },
    } as unknown as TransactionHost<never>);
  });

  /**
   * NON-FUNCTIONAL-REQUIREMENTS.md §1. Reading the hash on a path with no use
   * for it is a needless copy of the most sensitive value in the database —
   * and it travels, because a profile read crosses a queue into the gateway.
   */
  describe('the password hash is selected only where it is needed', () => {
    it('is read by findByEmail, which is about to verify against it', async () => {
      await service.findByEmail('a@b.c');

      expect(args(user.findUnique).select).toBeUndefined();
    });

    it.each([
      ['findById', () => service.findById(USER_ID), () => user.findUnique],
      [
        'create',
        () =>
          service.create({
            email: 'a@b.c',
            passwordHash: 'h',
            emailVerified: false,
          }),
        () => user.create,
      ],
      [
        'update',
        () => service.update(USER_ID, { displayName: 'Ada' }),
        () => user.update,
      ],
      [
        'changeEmail',
        () => service.changeEmail(USER_ID, 'new@b.c'),
        () => user.update,
      ],
      ['anonymize', () => service.anonymize(USER_ID), () => user.update],
    ])('is not read by %s', async (_label, call, mockFor) => {
      await call();

      const select = args(mockFor()).select as
        | Record<string, unknown>
        | undefined;

      expect(select).toBeDefined();
      expect(select?.passwordHash).toBeUndefined();
      // And it really is a projection, not an empty object.
      expect(select?.id).toBe(true);
    });

    it('is not read by the list, which reads many rows at once', async () => {
      await service.findManyForList({ where: {}, orderBy: [], take: 21 });

      const select = args(user.findMany).select as Record<string, unknown>;

      expect(select.passwordHash).toBeUndefined();
      expect(select.id).toBe(true);
    });
  });

  describe('lookups', () => {
    it('normalises before querying by address', async () => {
      await service.findByEmail('  ADA@Example.com ');

      expect(args(user.findUnique).where).toEqual({
        email: 'ada@example.com',
      });
    });

    it('reports an address held by another account as taken', async () => {
      user.findUnique.mockResolvedValue({ id: 'someone-else' });

      await expect(service.isEmailTaken('a@b.c', USER_ID)).resolves.toBe(true);
    });

    it('does not count the caller’s own address as taken', async () => {
      user.findUnique.mockResolvedValue({ id: USER_ID });

      await expect(service.isEmailTaken('a@b.c', USER_ID)).resolves.toBe(false);
    });

    it('reports a free address as free', async () => {
      await expect(service.isEmailTaken('a@b.c', USER_ID)).resolves.toBe(false);
    });
  });

  describe('list paging', () => {
    it('steps past the cursor row, which the caller already has', async () => {
      await service.findManyForList({
        where: {},
        orderBy: [],
        take: 21,
        cursorId: 'abc',
      });

      expect(args(user.findMany)).toMatchObject({
        cursor: { id: 'abc' },
        skip: 1,
      });
    });

    it('starts from the beginning when there is no cursor', async () => {
      await service.findManyForList({ where: {}, orderBy: [], take: 21 });

      expect('cursor' in args(user.findMany)).toBe(false);
    });
  });

  describe('login bookkeeping', () => {
    /** One write, not two. */
    it('records the login and clears the counter together', async () => {
      await service.recordSuccessfulLogin(USER_ID);

      expect(args(user.update).data).toMatchObject({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: expect.any(Date),
      });
    });

    it('increments on a failure', async () => {
      await service.recordLoginFailure(USER_ID);

      expect(args(user.update).data).toEqual({
        failedLoginAttempts: { increment: 1 },
      });
    });

    it('counts the attempt that locks the account', async () => {
      const until = new Date(Date.now() + 900_000);
      await service.lockLogin(USER_ID, until);

      expect(args(user.update).data).toEqual({
        failedLoginAttempts: { increment: 1 },
        lockedUntil: until,
      });
    });

    it('clears both the count and a lapsed lock', async () => {
      await service.resetLoginFailures(USER_ID);

      expect(args(user.update).data).toEqual({
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
    });
  });

  describe('update', () => {
    /** A new address is unproven by definition. */
    it('unverifies the address when an administrator changes it', async () => {
      await service.update(USER_ID, { email: 'NEW@b.c' });

      expect(args(user.update).data).toMatchObject({
        email: 'new@b.c',
        emailVerifiedAt: null,
      });
    });

    it('leaves the verification alone when the address is untouched', async () => {
      await service.update(USER_ID, { displayName: 'Ada' });

      expect('emailVerifiedAt' in (args(user.update).data as object)).toBe(
        false,
      );
    });
  });

  describe('changeEmail', () => {
    /** The one path that has proved the address marks it verified. */
    it('marks the new address verified in the same statement', async () => {
      await service.changeEmail(USER_ID, 'NEW@b.c');

      expect(args(user.update).data).toMatchObject({
        email: 'new@b.c',
        emailVerifiedAt: expect.any(Date),
      });
    });
  });

  describe('anonymize', () => {
    it('empties every personal column in one statement', async () => {
      await service.anonymize(USER_ID);

      expect(args(user.update).data).toMatchObject({
        email: anonymizedEmail(USER_ID),
        displayName: null,
        photoKey: null,
        emailVerifiedAt: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
        deletedAt: expect.any(Date),
      });
    });

    /**
     * Leaving a real hash of a real password in a row that has supposedly been
     * erased would defeat the whole exercise.
     */
    it('overwrites the password hash with something unusable', async () => {
      await service.anonymize(USER_ID);

      const { passwordHash } = args(user.update).data as {
        passwordHash: string;
      };

      expect(passwordHash).toBeDefined();
      expect(passwordHash.startsWith('$argon2')).toBe(false);
    });
  });

  describe('invalidateChallenges', () => {
    it('spends every live challenge', async () => {
      await service.invalidateChallenges(USER_ID);

      expect(verificationToken.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, usedAt: null },
        data: { usedAt: expect.any(Date) },
      });
    });

    /** An address the user typed should not outlive the account. */
    it('clears a pending address from every challenge, spent or not', async () => {
      await service.invalidateChallenges(USER_ID);

      expect(verificationToken.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, newEmail: { not: null } },
        data: { newEmail: null },
      });
    });
  });

  describe('clearRoles', () => {
    it('strips every assignment', async () => {
      await expect(service.clearRoles(USER_ID)).resolves.toBe(1);
      expect(userRoleAssignment.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
    });
  });

  describe('deleteUnverifiedBefore', () => {
    /** So a typo'd address does not hold an email hostage forever. */
    it('removes only unverified accounts older than the cutoff', async () => {
      const cutoff = new Date('2026-01-01T00:00:00.000Z');

      await expect(service.deleteUnverifiedBefore(cutoff)).resolves.toBe(3);
      expect(args(user.deleteMany).where).toEqual({
        emailVerifiedAt: null,
        createdAt: { lt: cutoff },
      });
    });
  });
});
