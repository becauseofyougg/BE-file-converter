import type { RmqContext } from '@nestjs/microservices';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';

import type { GrantsService } from './grants.service';
import type { PermissionsService } from './permissions.service';
import { RbacController } from './rbac.controller';
import type { RbacConfigService } from './rbac-config.service';
import type { RolesService } from './roles.service';
import type { UserRolesService } from './user-roles.service';

describe('identity RbacController', () => {
  let config: jest.Mocked<RbacConfigService>;
  let roles: jest.Mocked<RolesService>;
  let permissions: jest.Mocked<PermissionsService>;
  let grants: jest.Mocked<GrantsService>;
  let userRoles: jest.Mocked<UserRolesService>;
  let ack: jest.Mock;
  let context: RmqContext;
  let controller: RbacController;

  const message = { fields: { deliveryTag: 1 } };
  const ACTOR = { actorUserId: 'admin-1', correlationId: 'correlation-1' };

  beforeEach(() => {
    config = {
      getConfig: jest.fn().mockResolvedValue({ version: 'v1' }),
      check: jest.fn().mockResolvedValue({ allowed: true }),
    } as unknown as jest.Mocked<RbacConfigService>;

    roles = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'role-1' }),
      update: jest.fn().mockResolvedValue({ id: 'role-1' }),
      remove: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RolesService>;

    permissions = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'permission-1' }),
      update: jest.fn().mockResolvedValue({ id: 'permission-1' }),
      remove: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PermissionsService>;

    grants = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'grant-1' }),
      update: jest.fn().mockResolvedValue({ id: 'grant-1' }),
      remove: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<GrantsService>;

    userRoles = {
      namesFor: jest.fn().mockResolvedValue(['USER']),
      replace: jest.fn().mockResolvedValue(['ADMIN']),
    } as unknown as jest.Mocked<UserRolesService>;

    ack = jest.fn();
    context = {
      getChannelRef: () => ({ ack }),
      getMessage: () => message,
    } as unknown as RmqContext;

    controller = new RbacController(
      config,
      roles,
      permissions,
      grants,
      userRoles,
    );
  });

  describe('reads', () => {
    it('serves the config', async () => {
      await expect(controller.getConfig(context)).resolves.toEqual({
        version: 'v1',
      });
      expect(ack).toHaveBeenCalled();
    });

    /** For services that hold no cache of their own. */
    it('answers a check with the decision and its reason', async () => {
      config.check.mockResolvedValue({ allowed: false, reason: 'no_grant' });

      await expect(
        controller.check(
          { roles: ['USER'], permission: 'users', action: 'list' },
          context,
        ),
      ).resolves.toEqual({ allowed: false, reason: 'no_grant' });
    });

    it.each([
      ['listRoles', () => roles.list],
      ['listPermissions', () => permissions.list],
      ['listGrants', () => grants.list],
    ])('%s delegates and acks', async (method, mockFor) => {
      await (
        controller[method as 'listRoles'] as (
          context: RmqContext,
        ) => Promise<unknown>
      )(context);

      expect(mockFor()).toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(message);
    });

    it('reads a user’s role names', async () => {
      await expect(
        controller.getUserRoles({ userId: 'user-1' }, context),
      ).resolves.toEqual(['USER']);
    });
  });

  describe('writes', () => {
    it('creates a role, defaulting an absent description to null', async () => {
      await controller.createRole({ name: 'SUPPORT', ...ACTOR }, context);

      expect(roles.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'SUPPORT', description: null }),
      );
    });

    it('updates a role by id', async () => {
      await controller.updateRole(
        { id: 'role-1', name: 'HELPDESK', ...ACTOR },
        context,
      );

      expect(roles.update).toHaveBeenCalledWith(
        'role-1',
        expect.objectContaining({ name: 'HELPDESK' }),
      );
    });

    it.each([
      ['deleteRole', () => roles.remove],
      ['deletePermission', () => permissions.remove],
      ['deleteGrant', () => grants.remove],
    ])('%s removes by id', async (method, mockFor) => {
      await (
        controller[method as 'deleteRole'] as (
          dto: object,
          context: RmqContext,
        ) => Promise<void>
      )({ id: 'entity-1', ...ACTOR }, context);

      expect(mockFor()).toHaveBeenCalledWith(
        'entity-1',
        expect.objectContaining({ actorUserId: 'admin-1' }),
      );
    });

    it('creates a permission with its actions', async () => {
      await controller.createPermission(
        { name: 'reports', actions: ['read'], ...ACTOR },
        context,
      );

      expect(permissions.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'reports', actions: ['read'] }),
      );
    });

    it('creates a grant pairing a role with a permission', async () => {
      await controller.createGrant(
        { roleId: 'role-1', permissionId: 'permission-1', ...ACTOR },
        context,
      );

      expect(grants.create).toHaveBeenCalledWith(
        expect.objectContaining({
          roleId: 'role-1',
          permissionId: 'permission-1',
        }),
      );
    });

    it('updates a permission and a grant by id', async () => {
      await controller.updatePermission(
        { id: 'permission-1', actions: ['read'], ...ACTOR },
        context,
      );
      expect(permissions.update).toHaveBeenCalledWith(
        'permission-1',
        expect.any(Object),
      );

      await controller.updateGrant(
        { id: 'grant-1', actions: ['read'], ...ACTOR },
        context,
      );
      expect(grants.update).toHaveBeenCalledWith('grant-1', expect.any(Object));
    });

    it('replaces a user’s roles wholesale', async () => {
      await expect(
        controller.assignUserRoles(
          { userId: 'user-1', roles: ['ADMIN'], ...ACTOR },
          context,
        ),
      ).resolves.toEqual(['ADMIN']);

      expect(userRoles.replace).toHaveBeenCalledWith(
        'user-1',
        ['ADMIN'],
        expect.objectContaining({ actorUserId: 'admin-1' }),
      );
    });
  });

  describe('the actor and the correlation id', () => {
    /**
     * Identity trusts `actorUserId` for the audit trail alone, never for a
     * decision — authorisation happened at the gateway, which is the only
     * caller and the only one holding a token to check.
     */
    it('passes the actor through for the audit trail', async () => {
      await controller.createRole({ name: 'SUPPORT', ...ACTOR }, context);

      expect(roles.create).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'admin-1' }),
      );
    });

    /** Every write must be traceable, even one that arrived without an id. */
    it('generates a correlation id when the caller sent none', async () => {
      await controller.createRole({ name: 'SUPPORT' }, context);

      const { correlationId } = roles.create.mock.calls[0][0];

      expect(typeof correlationId).toBe('string');
      expect(correlationId.length).toBeGreaterThan(0);
    });
  });

  describe('acking', () => {
    /** A business refusal is a completed handling; retrying it is pointless. */
    it('acks a refusal rather than leaving it to redeliver', async () => {
      roles.create.mockRejectedValue(
        new AppError(ERROR_CODES.ROLE_ALREADY_EXISTS, 'Taken', 409),
      );

      await expect(
        controller.createRole({ name: 'SUPPORT', ...ACTOR }, context),
      ).rejects.toThrow(AppError);
      expect(ack).toHaveBeenCalledWith(message);
    });

    it('leaves a crash unacked, so the broker redelivers it', async () => {
      roles.create.mockRejectedValue(new Error('connection lost'));

      await expect(
        controller.createRole({ name: 'SUPPORT', ...ACTOR }, context),
      ).rejects.toThrow('connection lost');
      expect(ack).not.toHaveBeenCalled();
    });
  });
});
