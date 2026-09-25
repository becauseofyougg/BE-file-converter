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

import type { TransactionHost } from '@nestjs-cls/transactional';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { SYSTEM_ROLES } from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';

import type { RbacConfigService } from './rbac-config.service';
import { UserRolesService } from './user-roles.service';

const USER_ID = 'user-1';

describe('UserRolesService', () => {
  let role: { findUnique: jest.Mock; findMany: jest.Mock };
  let userRoleAssignment: {
    findMany: jest.Mock;
    create: jest.Mock;
    createMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  let config: jest.Mocked<RbacConfigService>;
  let service: UserRolesService;

  const actor = { actorUserId: 'admin-1', correlationId: 'correlation-1' };

  beforeEach(() => {
    role = {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'role-user', name: 'USER' }),
      findMany: jest.fn().mockResolvedValue([]),
    };
    userRoleAssignment = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(undefined),
      createMany: jest.fn().mockResolvedValue(undefined),
      deleteMany: jest.fn().mockResolvedValue(undefined),
    };

    config = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RbacConfigService>;

    service = new UserRolesService(
      { tx: { role, userRoleAssignment } } as unknown as TransactionHost<never>,
      config,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  describe('namesFor', () => {
    it('returns names, sorted, because they go into a token', async () => {
      userRoleAssignment.findMany.mockResolvedValue([
        { role: { name: 'USER' } },
        { role: { name: 'ADMIN' } },
      ]);

      await expect(service.namesFor(USER_ID)).resolves.toEqual([
        'ADMIN',
        'USER',
      ]);
    });

    it('returns nothing for a user holding no roles', async () => {
      await expect(service.namesFor(USER_ID)).resolves.toEqual([]);
    });
  });

  describe('assignDefault', () => {
    /**
     * Without it a fresh registration would hold no roles at all, and the
     * evaluator — which fails closed — would refuse it even its own profile.
     */
    it('gives a new account USER', async () => {
      await expect(service.assignDefault(USER_ID)).resolves.toEqual(['USER']);

      expect(role.findUnique).toHaveBeenCalledWith({
        where: { name: SYSTEM_ROLES.USER },
      });
      expect(userRoleAssignment.create).toHaveBeenCalledWith({
        data: { userId: USER_ID, roleId: 'role-user' },
      });
    });

    /**
     * The seed migration creates it; its absence means the database was
     * migrated by hand into a state the application cannot work in — which is
     * a 500, not a client error.
     */
    it('fails loudly when the seeded role is missing', async () => {
      role.findUnique.mockResolvedValue(null);

      const error = (await service
        .assignDefault(USER_ID)
        .catch((caught: AppError) => caught)) as AppError;

      expect(error.code).toBe(ERROR_CODES.ROLE_NOT_FOUND);
      expect(error.httpStatus).toBe(500);
    });
  });

  describe('replace', () => {
    beforeEach(() => {
      role.findMany.mockResolvedValue([
        { id: 'role-user', name: 'USER' },
        { id: 'role-admin', name: 'ADMIN' },
      ]);
    });

    it('swaps the whole set in one go', async () => {
      await expect(
        service.replace(USER_ID, ['USER', 'ADMIN'], actor),
      ).resolves.toEqual(['ADMIN', 'USER']);

      expect(userRoleAssignment.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
      expect(userRoleAssignment.createMany).toHaveBeenCalledWith({
        data: [
          { userId: USER_ID, roleId: 'role-user' },
          { userId: USER_ID, roleId: 'role-admin' },
        ],
      });
    });

    it('reloads the config, so the change applies without a restart', async () => {
      await service.replace(USER_ID, ['USER', 'ADMIN'], actor);

      expect(config.invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'user_roles', operation: 'update' }),
      );
    });

    it('ignores a repeated name rather than assigning it twice', async () => {
      role.findMany.mockResolvedValue([{ id: 'role-user', name: 'USER' }]);

      await service.replace(USER_ID, ['USER', 'USER'], actor);

      expect(userRoleAssignment.createMany).toHaveBeenCalledWith({
        data: [{ userId: USER_ID, roleId: 'role-user' }],
      });
    });

    /** Naming which ones are unknown, since the caller sent several. */
    it('refuses the whole set when one role does not exist', async () => {
      role.findMany.mockResolvedValue([{ id: 'role-user', name: 'USER' }]);

      const error = (await service
        .replace(USER_ID, ['USER', 'WIZARD'], actor)
        .catch((caught: AppError) => caught)) as AppError;

      expect(error.code).toBe(ERROR_CODES.ROLE_NOT_FOUND);
      expect(error.details).toEqual({ unknown: ['WIZARD'] });
      expect(userRoleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('can strip a user of every role', async () => {
      role.findMany.mockResolvedValue([]);

      await expect(service.replace(USER_ID, [], actor)).resolves.toEqual([]);
      expect(userRoleAssignment.deleteMany).toHaveBeenCalled();
    });
  });
});
