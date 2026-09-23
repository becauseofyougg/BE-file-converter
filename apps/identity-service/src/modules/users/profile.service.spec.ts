import { ERROR_CODES } from '@contracts/errors/error-codes';
import { PROFILE_FIELD_POLICY } from '@contracts/messages/users.messages';
import { AppError } from '@core/errors/app-error';
import { RbacConfigService } from '../rbac/rbac-config.service';
import { UserRolesService } from '../rbac/user-roles.service';
import { ProfileService } from './profile.service';
import { UsersService, type User } from './users.service';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: TARGET,
    email: 'target@example.com',
    passwordHash: '$argon2id$stub',
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    photoKey: 'profile-photos/target.jpg',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

describe('ProfileService', () => {
  let users: jest.Mocked<UsersService>;
  let userRoles: jest.Mocked<UserRolesService>;
  let rbac: jest.Mocked<RbacConfigService>;
  let service: ProfileService;

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(buildUser()),
    } as unknown as jest.Mocked<UsersService>;

    userRoles = {
      namesFor: jest.fn().mockResolvedValue(['USER']),
    } as unknown as jest.Mocked<UserRolesService>;

    rbac = {
      check: jest
        .fn()
        .mockResolvedValue({ allowed: false, reason: 'no_grant' }),
    } as unknown as jest.Mocked<RbacConfigService>;

    service = new ProfileService(users, userRoles, rbac);
  });

  const read = (targetUserId = TARGET, viewerRoles: string[] = ['USER']) =>
    service.getProfile({
      targetUserId,
      viewerUserId: VIEWER,
      viewerRoles,
      correlationId: 'correlation-1',
    });

  describe('self', () => {
    const readSelf = () =>
      service.getProfile({
        targetUserId: VIEWER,
        viewerUserId: VIEWER,
        viewerRoles: ['USER'],
        correlationId: 'correlation-1',
      });

    beforeEach(() => {
      users.findById.mockResolvedValue(buildUser({ id: VIEWER }));
    });

    it('returns the profile without consulting RBAC at all', async () => {
      const profile = await readSelf();

      expect(profile.id).toBe(VIEWER);
      expect(profile.email).toBe('target@example.com');
      // Self is an ownership fact, not a role — §3. A user who holds no
      // permission whatsoever still sees their own profile.
      expect(rbac.check).not.toHaveBeenCalled();
    });

    it('includes the roles the user holds', async () => {
      userRoles.namesFor.mockResolvedValue(['USER', 'ADMIN']);

      await expect(readSelf()).resolves.toMatchObject({
        roles: ['USER', 'ADMIN'],
      });
    });
  });

  describe('someone else', () => {
    it('refuses a viewer without users@read', async () => {
      await expect(read()).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.FORBIDDEN }),
      );
    });

    /**
     * The oracle test, and the reason authorisation runs before the lookup.
     * A 404 for an unknown id and a 403 for a known one would let anyone
     * holding no permission at all enumerate which user ids exist.
     */
    it('does not even look the target up when the viewer may not', async () => {
      await expect(read()).rejects.toThrow(AppError);

      expect(users.findById).not.toHaveBeenCalled();
    });

    it('allows a viewer that holds users@read', async () => {
      rbac.check.mockResolvedValue({ allowed: true, grantedBy: 'SUPPORT' });

      await expect(read(TARGET, ['SUPPORT'])).resolves.toMatchObject({
        id: TARGET,
        email: 'target@example.com',
      });
      expect(rbac.check).toHaveBeenCalledWith(['SUPPORT'], 'users', 'read');
    });

    it('withholds the roles, which are only for the account itself', async () => {
      rbac.check.mockResolvedValue({ allowed: true });

      const profile = await read(TARGET, ['SUPPORT']);

      expect(profile.roles).toBeUndefined();
      expect(userRoles.namesFor).not.toHaveBeenCalled();
    });

    it('reports a missing user once the viewer is allowed to know', async () => {
      rbac.check.mockResolvedValue({ allowed: true });
      users.findById.mockResolvedValue(null);

      await expect(read(TARGET, ['SUPPORT'])).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.USER_NOT_FOUND }),
      );
    });
  });

  describe('default-deny', () => {
    /**
     * The filter walks the allow-list, not the row, so a column added to the
     * model later cannot appear here by accident. This asserts the mechanism
     * rather than any particular field: a stray property on the record must
     * not survive the projection.
     */
    it('serializes nothing the policy does not name', async () => {
      rbac.check.mockResolvedValue({ allowed: true });
      users.findById.mockResolvedValue(
        buildUser({
          passwordHash: '$argon2id$the-real-one',
        } as Partial<User>),
      );

      const profile = await read(TARGET, ['SUPPORT']);

      expect(Object.keys(profile).sort()).toEqual(
        // `photo` is the public name; what identity emits is `photoKey`.
        ['photoKey', 'emailVerified', 'createdAt', 'email', 'id'].sort(),
      );
      expect(JSON.stringify(profile)).not.toContain('argon2id');
    });

    it('keeps the two audiences distinct', () => {
      expect(PROFILE_FIELD_POLICY.self).toContain('roles');
      expect(PROFILE_FIELD_POLICY.other).not.toContain('roles');
    });
  });
});
