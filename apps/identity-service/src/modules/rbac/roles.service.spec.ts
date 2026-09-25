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
import type { Role } from '@prisma-clients/identity';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';

import type { RbacConfigService } from './rbac-config.service';
import { RolesService } from './roles.service';

function buildRole(overrides: Partial<Role> = {}): Role {
  return {
    id: 'role-1',
    name: 'SUPPORT',
    description: 'Reads profiles',
    isSystem: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Role;
}

describe('RolesService', () => {
  let role: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let userRoleAssignment: { count: jest.Mock };
  let config: jest.Mocked<RbacConfigService>;
  let service: RolesService;

  const actor = { actorUserId: 'admin-1', correlationId: 'correlation-1' };

  beforeEach(() => {
    role = {
      findMany: jest.fn().mockResolvedValue([buildRole()]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(buildRole()),
      update: jest.fn().mockResolvedValue(buildRole()),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    userRoleAssignment = { count: jest.fn().mockResolvedValue(0) };

    config = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RbacConfigService>;

    service = new RolesService(
      { tx: { role, userRoleAssignment } } as unknown as TransactionHost<never>,
      config,
    );
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  describe('list', () => {
    it('returns the roles as DTOs, alphabetically', async () => {
      await expect(service.list()).resolves.toEqual([
        {
          id: 'role-1',
          name: 'SUPPORT',
          description: 'Reads profiles',
          isSystem: false,
        },
      ]);
      expect(role.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
    });
  });

  describe('create', () => {
    it('creates a non-system role and reloads the config', async () => {
      await service.create({ name: 'SUPPORT', ...actor });

      expect(role.create).toHaveBeenCalledWith({
        data: { name: 'SUPPORT', description: null, isSystem: false },
      });
      expect(config.invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'role', operation: 'create' }),
      );
    });

    /**
     * A role created through the API must never be a system role — that flag is
     * what protects the seeded ones from being renamed or deleted.
     */
    it('never lets a caller mint a system role', async () => {
      await service.create({
        name: 'SUPPORT',
        ...actor,
      } as Parameters<RolesService['create']>[0]);

      expect(role.create.mock.calls[0][0].data.isSystem).toBe(false);
    });

    it('refuses a name already taken', async () => {
      role.findUnique.mockResolvedValue(buildRole());

      await expect(
        service.create({ name: 'SUPPORT', ...actor }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.ROLE_ALREADY_EXISTS }),
      );
      expect(role.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    beforeEach(() => {
      role.findUnique.mockImplementation(
        ({ where }: { where: { id?: string; name?: string } }) =>
          Promise.resolve(where.id ? buildRole() : null),
      );
    });

    it('renames a role and reloads the config', async () => {
      await service.update('role-1', { name: 'HELPDESK', ...actor });

      expect(role.update).toHaveBeenCalledWith({
        where: { id: 'role-1' },
        data: { name: 'HELPDESK', description: 'Reads profiles' },
      });
      expect(config.invalidate).toHaveBeenCalled();
    });

    /**
     * The seeded grants and every token already issued refer to a role by
     * name, so renaming a system role would quietly detach both.
     */
    it('refuses to rename a system role', async () => {
      role.findUnique.mockResolvedValue(buildRole({ isSystem: true }));

      await expect(
        service.update('role-1', { name: 'SOMETHING_ELSE', ...actor }),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.ENTITY_IMMUTABLE }),
      );
    });

    it('lets a system role keep its name and change its description', async () => {
      role.findUnique.mockResolvedValue(
        buildRole({ isSystem: true, name: 'ADMIN' }),
      );

      await expect(
        service.update('role-1', { name: 'ADMIN', description: 'x', ...actor }),
      ).resolves.toBeDefined();
    });

    it('clears a description when asked with null', async () => {
      await service.update('role-1', { description: null, ...actor });

      expect(role.update.mock.calls[0][0].data.description).toBeNull();
    });

    it('leaves a description alone when it is not mentioned', async () => {
      await service.update('role-1', { ...actor });

      expect(role.update.mock.calls[0][0].data.description).toBe(
        'Reads profiles',
      );
    });

    it('404s on a role that does not exist', async () => {
      role.findUnique.mockResolvedValue(null);

      await expect(service.update('nope', { ...actor })).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.ROLE_NOT_FOUND }),
      );
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      role.findUnique.mockResolvedValue(buildRole());
    });

    it('deletes an unheld, non-system role', async () => {
      await service.remove('role-1', actor);

      expect(role.delete).toHaveBeenCalledWith({ where: { id: 'role-1' } });
      expect(config.invalidate).toHaveBeenCalled();
    });

    /**
     * §1.3.2 leaves "refuse or cascade" open, and it refuses: cascading would
     * silently revoke access from everyone holding the role, and the one thing
     * an access-control change must never be is silent.
     */
    it('refuses while anyone still holds it, and says how many', async () => {
      userRoleAssignment.count.mockResolvedValue(3);

      const error = (await service
        .remove('role-1', actor)
        .catch((caught: AppError) => caught)) as AppError;

      expect(error.code).toBe(ERROR_CODES.ENTITY_IN_USE);
      expect(error.details).toEqual({ users: 3 });
      expect(role.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a system role', async () => {
      role.findUnique.mockResolvedValue(buildRole({ isSystem: true }));

      await expect(service.remove('role-1', actor)).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.ENTITY_IMMUTABLE }),
      );
    });

    it('404s on a role that does not exist', async () => {
      role.findUnique.mockResolvedValue(null);

      await expect(service.remove('nope', actor)).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.ROLE_NOT_FOUND }),
      );
    });
  });
});
