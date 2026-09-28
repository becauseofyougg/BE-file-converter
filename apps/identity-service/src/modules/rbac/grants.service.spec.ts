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
import { AppError } from '@core/errors/app-error';

import { GrantsService } from './grants.service';
import type { PermissionsService } from './permissions.service';
import type { RbacConfigService } from './rbac-config.service';
import type { RolesService } from './roles.service';

const GRANT = {
  id: 'grant-1',
  roleId: 'role-1',
  permissionId: 'permission-1',
  actions: ['read'],
  role: { name: 'SUPPORT' },
  permission: { name: 'users' },
};

describe('GrantsService', () => {
  let grant: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let roles: jest.Mocked<RolesService>;
  let permissions: jest.Mocked<PermissionsService>;
  let config: jest.Mocked<RbacConfigService>;
  let service: GrantsService;

  const actor = { actorUserId: 'admin-1', correlationId: 'correlation-1' };

  beforeEach(() => {
    grant = {
      findMany: jest.fn().mockResolvedValue([GRANT]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(GRANT),
      update: jest.fn().mockResolvedValue(GRANT),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    roles = {
      require: jest.fn().mockResolvedValue({ id: 'role-1', name: 'SUPPORT' }),
    } as unknown as jest.Mocked<RolesService>;

    permissions = {
      require: jest.fn().mockResolvedValue({
        id: 'permission-1',
        name: 'users',
        actions: ['read', 'update', 'delete'],
      }),
    } as unknown as jest.Mocked<PermissionsService>;

    config = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RbacConfigService>;

    service = new GrantsService(
      { tx: { grant } } as unknown as TransactionHost<never>,
      roles,
      permissions,
      config,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  const created = () =>
    grant.create.mock.calls[0][0].data as {
      actions: string[];
    };

  describe('create', () => {
    it('checks both ends exist before writing anything', async () => {
      await service.create({
        roleId: 'role-1',
        permissionId: 'permission-1',
        actions: ['read'],
        ...actor,
      });

      expect(roles.require).toHaveBeenCalledWith('role-1');
      expect(permissions.require).toHaveBeenCalledWith('permission-1');
    });

    /**
     * §1.3.4: an action a grant names must be one the permission defines.
     * Rejecting at write time is the difference between an administrator
     * seeing their typo and believing they granted something they did not.
     */
    it('refuses an action the permission does not define, and names it', async () => {
      const error = (await service
        .create({
          roleId: 'role-1',
          permissionId: 'permission-1',
          actions: ['read', 'summon'],
          ...actor,
        })
        .catch((caught: AppError) => caught)) as AppError;

      expect(error.code).toBe(ERROR_CODES.INVALID_ACTION);
      expect(error.details).toMatchObject({ unknown: ['summon'] });
      expect(grant.create).not.toHaveBeenCalled();
    });

    /**
     * Naming every action is the same thing as naming none, and storing "none"
     * means a later addition to the permission is picked up too.
     */
    it('collapses "every action" to an empty list', async () => {
      await service.create({
        roleId: 'role-1',
        permissionId: 'permission-1',
        actions: ['read', 'update', 'delete'],
        ...actor,
      });

      expect(created().actions).toEqual([]);
    });

    it('treats an omitted action list as every action', async () => {
      await service.create({
        roleId: 'role-1',
        permissionId: 'permission-1',
        ...actor,
      });

      expect(created().actions).toEqual([]);
    });

    it('sorts and deduplicates a partial list', async () => {
      await service.create({
        roleId: 'role-1',
        permissionId: 'permission-1',
        actions: ['update', 'read', 'read'],
        ...actor,
      });

      expect(created().actions).toEqual(['read', 'update']);
    });

    /**
     * One grant per (role, permission) — a second would make the effective
     * actions depend on which row was read first.
     */
    it('refuses a second grant for the same pair', async () => {
      grant.findUnique.mockResolvedValue(GRANT);

      await expect(
        service.create({
          roleId: 'role-1',
          permissionId: 'permission-1',
          ...actor,
        }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.GRANT_ALREADY_EXISTS }),
      );
    });

    it('reloads the config so the change applies without a restart', async () => {
      await service.create({
        roleId: 'role-1',
        permissionId: 'permission-1',
        ...actor,
      });

      expect(config.invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'grant', operation: 'create' }),
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      grant.findUnique.mockImplementation(
        ({ where }: { where: { id?: string } }) =>
          Promise.resolve(where.id ? GRANT : null),
      );
    });

    it('revalidates the kept actions against the permission', async () => {
      permissions.require.mockResolvedValue({
        id: 'permission-1',
        name: 'users',
        actions: ['update'],
      } as Awaited<ReturnType<PermissionsService['require']>>);

      await expect(service.update('grant-1', { ...actor })).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_ACTION }),
      );
    });

    it('404s on a grant that does not exist', async () => {
      grant.findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { ...actor })).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.GRANT_NOT_FOUND }),
      );
    });

    it('refuses to move a grant onto a pair another one already holds', async () => {
      grant.findUnique.mockImplementation(
        ({ where }: { where: { id?: string } }) =>
          Promise.resolve(where.id ? GRANT : { ...GRANT, id: 'grant-2' }),
      );

      await expect(
        service.update('grant-1', { roleId: 'role-2', ...actor }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.GRANT_ALREADY_EXISTS }),
      );
    });
  });

  describe('remove', () => {
    it('deletes it and reloads the config', async () => {
      grant.findUnique.mockResolvedValue(GRANT);

      await service.remove('grant-1', actor);

      expect(grant.delete).toHaveBeenCalledWith({ where: { id: 'grant-1' } });
      expect(config.invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'grant', operation: 'delete' }),
      );
    });

    it('404s on a grant that does not exist', async () => {
      grant.findUnique.mockResolvedValue(null);

      await expect(service.remove('nope', actor)).rejects.toThrow(AppError);
    });
  });

  describe('list', () => {
    it('returns DTOs carrying the role and permission names', async () => {
      await expect(service.list()).resolves.toEqual([
        {
          id: 'grant-1',
          roleId: 'role-1',
          roleName: 'SUPPORT',
          permissionId: 'permission-1',
          permissionName: 'users',
          actions: ['read'],
        },
      ]);
    });
  });
});
