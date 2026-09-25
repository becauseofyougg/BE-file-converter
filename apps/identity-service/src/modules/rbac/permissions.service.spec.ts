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
import type { Permission } from '@prisma-clients/identity';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';

import { PermissionsService } from './permissions.service';
import type { RbacConfigService } from './rbac-config.service';

function buildPermission(overrides: Partial<Permission> = {}): Permission {
  return {
    id: 'permission-1',
    name: 'users',
    actions: ['read', 'update', 'delete'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Permission;
}

describe('PermissionsService', () => {
  let permission: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let grant: {
    count: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let config: jest.Mocked<RbacConfigService>;
  let service: PermissionsService;

  const actor = { actorUserId: 'admin-1', correlationId: 'correlation-1' };

  beforeEach(() => {
    permission = {
      findMany: jest.fn().mockResolvedValue([buildPermission()]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(buildPermission()),
      update: jest.fn().mockResolvedValue(buildPermission()),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    grant = {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    config = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RbacConfigService>;

    service = new PermissionsService(
      { tx: { permission, grant } } as unknown as TransactionHost<never>,
      config,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  describe('list', () => {
    it('returns DTOs', async () => {
      await expect(service.list()).resolves.toEqual([
        {
          id: 'permission-1',
          name: 'users',
          actions: ['read', 'update', 'delete'],
        },
      ]);
    });
  });

  describe('create', () => {
    it('stores the actions sorted, deduplicated and trimmed', async () => {
      await service.create({
        name: 'users',
        actions: [' read ', 'read', 'delete', ''],
        ...actor,
      });

      expect(permission.create).toHaveBeenCalledWith({
        data: { name: 'users', actions: ['delete', 'read'] },
      });
    });

    it('refuses a name already taken', async () => {
      permission.findUnique.mockResolvedValue(buildPermission());

      await expect(
        service.create({ name: 'users', actions: ['read'], ...actor }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: ERROR_CODES.PERMISSION_ALREADY_EXISTS,
        }),
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      permission.findUnique.mockImplementation(
        ({ where }: { where: { id?: string; name?: string } }) =>
          Promise.resolve(where.id ? buildPermission() : null),
      );
    });

    it('leaves the actions alone when they are not mentioned', async () => {
      await service.update('permission-1', { name: 'accounts', ...actor });

      expect(permission.update.mock.calls[0][0].data.actions).toEqual([
        'read',
        'update',
        'delete',
      ]);
    });

    /**
     * A grant that named a removed action would otherwise be dead weight the
     * evaluator silently ignores.
     */
    it('narrows a grant that named a removed action', async () => {
      grant.findMany.mockResolvedValue([
        { id: 'grant-1', actions: ['read', 'delete'] },
      ]);

      await service.update('permission-1', { actions: ['read'], ...actor });

      expect(grant.update).toHaveBeenCalledWith({
        where: { id: 'grant-1' },
        data: { actions: ['read'] },
      });
    });

    /**
     * Emptying it would turn it into "every action" — the opposite of what its
     * author meant — so it goes.
     */
    it('deletes a grant left with nothing rather than emptying it', async () => {
      grant.findMany.mockResolvedValue([
        { id: 'grant-1', actions: ['delete'] },
      ]);

      await service.update('permission-1', { actions: ['read'], ...actor });

      expect(grant.delete).toHaveBeenCalledWith({ where: { id: 'grant-1' } });
      expect(grant.update).not.toHaveBeenCalled();
    });

    /** An empty list already means "all actions", including ones added later. */
    it('leaves an all-actions grant untouched', async () => {
      grant.findMany.mockResolvedValue([{ id: 'grant-1', actions: [] }]);

      await service.update('permission-1', { actions: ['read'], ...actor });

      expect(grant.update).not.toHaveBeenCalled();
      expect(grant.delete).not.toHaveBeenCalled();
    });

    it('touches no grants when the actions only grow', async () => {
      await service.update('permission-1', {
        actions: ['read', 'update', 'delete', 'list'],
        ...actor,
      });

      expect(grant.findMany).not.toHaveBeenCalled();
    });

    it('404s on a permission that does not exist', async () => {
      permission.findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { ...actor })).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.PERMISSION_NOT_FOUND }),
      );
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      permission.findUnique.mockResolvedValue(buildPermission());
    });

    it('deletes one nothing points at', async () => {
      await service.remove('permission-1', actor);

      expect(permission.delete).toHaveBeenCalledWith({
        where: { id: 'permission-1' },
      });
      expect(config.invalidate).toHaveBeenCalled();
    });

    it('refuses while grants still name it, and says how many', async () => {
      grant.count.mockResolvedValue(2);

      const error = (await service
        .remove('permission-1', actor)
        .catch((caught: AppError) => caught)) as AppError;

      expect(error.code).toBe(ERROR_CODES.ENTITY_IN_USE);
      expect(error.details).toEqual({ grants: 2 });
      expect(permission.delete).not.toHaveBeenCalled();
    });
  });

  describe('require', () => {
    it('404s rather than returning null', async () => {
      permission.findUnique.mockResolvedValue(null);

      await expect(service.require('nope')).rejects.toThrow(AppError);
    });
  });
});
