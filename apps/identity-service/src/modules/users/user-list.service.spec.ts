import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  USER_LIST_LIMITS,
  USER_STATUSES,
} from '@contracts/messages/users.messages';
import { AppError } from '@core/errors/app-error';
import { RbacConfigService } from '../rbac/rbac-config.service';
import { encodeCursor } from './user-list.cursor';
import { UserListService, statusOf } from './user-list.service';
import { UsersService, type User } from './users.service';

const ADMIN = '11111111-1111-4111-8111-111111111111';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'user@example.com',
    displayName: 'User',
    passwordHash: '$argon2id$stub',
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    deletedAt: null,
    photoKey: null,
    lastLoginAt: new Date('2026-06-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

describe('UserListService', () => {
  let users: jest.Mocked<UsersService>;
  let rbac: jest.Mocked<RbacConfigService>;
  let service: UserListService;

  beforeEach(() => {
    users = {
      findManyForList: jest.fn().mockResolvedValue([buildUser()]),
    } as unknown as jest.Mocked<UsersService>;

    rbac = {
      check: jest.fn().mockResolvedValue({ allowed: true }),
    } as unknown as jest.Mocked<RbacConfigService>;

    service = new UserListService(users, rbac);
  });

  const list = (input: Record<string, unknown> = {}) =>
    service.listUsers({
      viewerUserId: ADMIN,
      viewerRoles: ['ADMIN'],
      correlationId: 'correlation-1',
      ...input,
    });

  const lastQuery = () => users.findManyForList.mock.calls.at(-1)?.[0];

  describe('authorisation', () => {
    it('demands users@list, which is not users@read', async () => {
      await list();

      expect(rbac.check).toHaveBeenCalledWith(['ADMIN'], 'users', 'list');
    });

    it('refuses a viewer without it, and queries nothing', async () => {
      rbac.check.mockResolvedValue({ allowed: false, reason: 'no_grant' });

      await expect(list()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.FORBIDDEN }),
      );
      expect(users.findManyForList).not.toHaveBeenCalled();
    });
  });

  describe('paging', () => {
    it('asks for one row more than the page, to know if there is another', async () => {
      await list({ limit: 20 });

      expect(lastQuery()?.take).toBe(21);
    });

    it('returns a cursor only when that extra row came back', async () => {
      users.findManyForList.mockResolvedValue([
        buildUser({ id: 'a' }),
        buildUser({ id: 'b' }),
      ]);

      const page = await list({ limit: 1 });

      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
    });

    it('ends the walk with a null cursor', async () => {
      const page = await list({ limit: 20 });

      expect(page.nextCursor).toBeNull();
    });

    it('resumes past the cursor row, which the caller already has', async () => {
      const cursor = encodeCursor({
        id: 'abc',
        sort: 'created_at',
        order: 'desc',
      });

      await list({ cursor });

      expect(lastQuery()?.cursorId).toBe('abc');
    });

    /**
     * A position in one ordering means nothing in another. Interpreting it
     * anyway silently skips and repeats rows, so the only safe answer is to
     * refuse.
     */
    it('refuses a cursor from a different sort', async () => {
      const cursor = encodeCursor({
        id: 'abc',
        sort: 'email',
        order: 'asc',
      });

      await expect(list({ cursor, sort: 'created_at' })).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.VALIDATION_FAILED }),
      );
    });

    it('refuses a cursor that is not one of ours', async () => {
      await expect(list({ cursor: 'not-base64-json' })).rejects.toThrow(
        AppError,
      );
    });

    it('defaults the page size rather than returning everything', async () => {
      await list();

      expect(lastQuery()?.take).toBe(USER_LIST_LIMITS.DEFAULT + 1);
    });

    it('clamps a limit past the ceiling', async () => {
      await list({ limit: 10_000 });

      expect(lastQuery()?.take).toBe(USER_LIST_LIMITS.MAX + 1);
    });
  });

  describe('ordering', () => {
    /**
     * Without the tie-break two rows sharing a sort value have no defined order
     * between them, and a cursor on that boundary skips one and repeats another.
     */
    it('always tie-breaks on id, so the sequence is total', async () => {
      await list({ sort: 'created_at', order: 'desc' });

      expect(lastQuery()?.orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    /** "Never signed in" is not a date; sorting it first buries everyone else. */
    it('puts accounts that never signed in last, either direction', async () => {
      await list({ sort: 'last_login', order: 'asc' });

      expect(lastQuery()?.orderBy).toEqual([
        { lastLoginAt: { sort: 'asc', nulls: 'last' } },
        { id: 'asc' },
      ]);
    });

    it('defaults to newest first', async () => {
      await list();

      expect(lastQuery()?.orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });
  });

  describe('filtering', () => {
    it('hides erased accounts unless they are asked for', async () => {
      await list();

      expect(lastQuery()?.where).toMatchObject({ deletedAt: null });
    });

    it('shows only erased ones on request', async () => {
      await list({ status: USER_STATUSES.DELETED });

      expect(lastQuery()?.where).toMatchObject({ deletedAt: { not: null } });
    });

    it('searches an exact address and a partial name', async () => {
      await list({ q: 'ada' });

      expect(lastQuery()?.where.OR).toEqual([
        { email: 'ada' },
        { displayName: { contains: 'ada', mode: 'insensitive' } },
      ]);
    });

    it('adds an id match only when the term could be one', async () => {
      await list({ q: '22222222-2222-4222-8222-222222222222' });

      expect(lastQuery()?.where.OR).toContainEqual({
        id: '22222222-2222-4222-8222-222222222222',
      });
    });

    it('ignores a blank search rather than matching everything', async () => {
      await list({ q: '   ' });

      expect(lastQuery()?.where.OR).toBeUndefined();
    });
  });

  describe('the projection', () => {
    /**
     * §1.4. The mapper names every field, so a column added to `users` later
     * cannot appear here by accident.
     */
    it('carries nothing but the listed fields', async () => {
      const page = await list();

      expect(Object.keys(page.items[0]).sort()).toEqual(
        [
          'id',
          'email',
          'displayName',
          'photoKey',
          'status',
          'createdAt',
          'lastLoginAt',
        ].sort(),
      );
      expect(JSON.stringify(page.items)).not.toContain('argon2id');
    });
  });

  describe('statusOf', () => {
    it.each([
      ['erased', { deletedAt: new Date() }, USER_STATUSES.DELETED],
      ['unconfirmed', { emailVerifiedAt: null }, USER_STATUSES.UNVERIFIED],
      [
        'locked out',
        { lockedUntil: new Date(Date.now() + 600_000) },
        USER_STATUSES.LOCKED,
      ],
      [
        'lapsed lock',
        { lockedUntil: new Date(Date.now() - 600_000) },
        USER_STATUSES.ACTIVE,
      ],
      ['ordinary', {}, USER_STATUSES.ACTIVE],
    ])('reports %s as %s', (_label, overrides, expected) => {
      expect(statusOf(buildUser(overrides as Partial<User>))).toBe(expected);
    });

    /** An erased account is erased whatever else its columns say. */
    it('lets erasure win over every other state', () => {
      expect(
        statusOf(
          buildUser({
            deletedAt: new Date(),
            emailVerifiedAt: null,
            lockedUntil: new Date(Date.now() + 600_000),
          }),
        ),
      ).toBe(USER_STATUSES.DELETED);
    });
  });
});
