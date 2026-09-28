import { Reflector } from '@nestjs/core';
import type { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import type { FastifyRequest } from 'fastify';

import { RBAC_PATTERNS } from '@contracts/messages/rbac.messages';

import type { RequestUser } from '../auth/jwt-auth.guard';
import { RbacAdminController } from './rbac-admin.controller';
import { REQUIRED_PERMISSIONS } from './rbac.guard';

const ADMIN: RequestUser = { id: 'admin-1', roles: ['ADMIN'], tokenId: 'jti' };

describe('RbacAdminController', () => {
  let send: jest.Mock;
  let controller: RbacAdminController;

  const request = { headers: {}, id: 'req-1' } as unknown as FastifyRequest;

  const sentPattern = () => send.mock.calls[0][0] as string;
  const sentPayload = () => send.mock.calls[0][1] as Record<string, unknown>;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of([]));
    controller = new RbacAdminController({ send } as unknown as ClientProxy);
  });

  /**
   * The requirement is declared here rather than assumed from a role name, so
   * handing a new role the same power is a data change, not a deploy.
   */
  describe('permissions are declared, not assumed', () => {
    const reflector = new Reflector();

    it('requires rbac@manage on the controller', () => {
      expect(
        reflector.get<string[]>(REQUIRED_PERMISSIONS, RbacAdminController),
      ).toEqual(['rbac@manage']);
    });

    /** Reading the rules is a lesser power than changing them. */
    it.each([
      'getConfig',
      'listRoles',
      'listPermissions',
      'listGrants',
      'getUserRoles',
    ])('lets %s through on rbac@read instead', (method) => {
      expect(
        reflector.get<string[]>(
          REQUIRED_PERMISSIONS,
          RbacAdminController.prototype[
            method as keyof RbacAdminController
          ] as () => unknown,
        ),
      ).toEqual(['rbac@read']);
    });

    it.each(['createRole', 'updateRole', 'deleteRole', 'assignUserRoles'])(
      'leaves %s on the controller-level rbac@manage',
      (method) => {
        expect(
          reflector.get(
            REQUIRED_PERMISSIONS,
            RbacAdminController.prototype[
              method as keyof RbacAdminController
            ] as () => unknown,
          ),
        ).toBeUndefined();
      },
    );
  });

  describe('forwarding', () => {
    it('sends each read under its own pattern', async () => {
      await controller.getConfig(request);

      expect(sentPattern()).toBe(RBAC_PATTERNS.GET_CONFIG);
    });

    it('merges the path id into the body on an update', async () => {
      await controller.updateRole(
        'role-1',
        { name: 'SUPPORT' },
        ADMIN,
        request,
      );

      expect(sentPayload()).toMatchObject({ id: 'role-1', name: 'SUPPORT' });
    });

    it('sends only the id on a delete', async () => {
      await controller.deleteRole('role-1', ADMIN, request);

      expect(sentPattern()).toBe(RBAC_PATTERNS.DELETE_ROLE);
      expect(sentPayload()).toMatchObject({ id: 'role-1' });
    });

    it('pairs the user id with the roles on an assignment', async () => {
      await controller.assignUserRoles(
        'user-1',
        { roles: ['ADMIN'] },
        ADMIN,
        request,
      );

      expect(sentPayload()).toMatchObject({
        userId: 'user-1',
        roles: ['ADMIN'],
      });
    });
  });

  describe('the actor', () => {
    /**
     * It travels for the audit trail only — identity never authorises on it,
     * because a value the gateway puts in a message is not a credential.
     */
    it('is attached to a write', async () => {
      await controller.createRole({ name: 'SUPPORT' }, ADMIN, request);

      expect(sentPayload()).toMatchObject({ actorUserId: 'admin-1' });
    });

    it('is absent from a read, which has nothing to audit', async () => {
      await controller.listRoles(request);

      expect('actorUserId' in sentPayload()).toBe(false);
    });
  });

  describe('the correlation id', () => {
    it('comes from the inbound header when there is one', async () => {
      await controller.listRoles({
        headers: { 'x-correlation-id': 'trace-abc' },
        id: 'req-1',
      } as unknown as FastifyRequest);

      expect(sentPayload()).toMatchObject({ correlationId: 'trace-abc' });
    });

    it('falls back to the request id', async () => {
      await controller.listRoles(request);

      expect(sentPayload()).toMatchObject({ correlationId: 'req-1' });
    });

    it('is generated when there is neither', async () => {
      await controller.listRoles({
        headers: {},
      } as unknown as FastifyRequest);

      expect(typeof sentPayload().correlationId).toBe('string');
    });
  });

  describe('the remaining endpoints', () => {
    it.each([
      ['listPermissions', RBAC_PATTERNS.LIST_PERMISSIONS],
      ['listGrants', RBAC_PATTERNS.LIST_GRANTS],
    ])('%s sends %s', async (method, pattern) => {
      await (
        controller[method as 'listGrants'] as (
          request: FastifyRequest,
        ) => Promise<unknown>
      )(request);

      expect(sentPattern()).toBe(pattern);
    });

    it('creates a permission with its actions', async () => {
      await controller.createPermission(
        { name: 'reports', actions: ['read'] },
        ADMIN,
        request,
      );

      expect(sentPattern()).toBe(RBAC_PATTERNS.CREATE_PERMISSION);
      expect(sentPayload()).toMatchObject({ name: 'reports' });
    });

    it('creates a grant pairing a role with a permission', async () => {
      await controller.createGrant(
        { roleId: 'role-1', permissionId: 'permission-1' },
        ADMIN,
        request,
      );

      expect(sentPattern()).toBe(RBAC_PATTERNS.CREATE_GRANT);
    });

    it.each([
      ['deletePermission', RBAC_PATTERNS.DELETE_PERMISSION],
      ['deleteGrant', RBAC_PATTERNS.DELETE_GRANT],
    ])('%s sends %s with the id', async (method, pattern) => {
      await (
        controller[method as 'deleteGrant'] as (
          id: string,
          user: RequestUser,
          request: FastifyRequest,
        ) => Promise<void>
      )('entity-1', ADMIN, request);

      expect(sentPattern()).toBe(pattern);
      expect(sentPayload()).toMatchObject({ id: 'entity-1' });
    });

    it('updates a permission and a grant by id', async () => {
      await controller.updatePermission(
        'permission-1',
        { actions: ['read'] },
        ADMIN,
        request,
      );
      expect(sentPayload()).toMatchObject({ id: 'permission-1' });

      send.mockClear();
      await controller.updateGrant(
        'grant-1',
        { actions: ['read'] },
        ADMIN,
        request,
      );
      expect(sentPayload()).toMatchObject({ id: 'grant-1' });
    });

    it('reads a user’s roles by id', async () => {
      await controller.getUserRoles('user-1', request);

      expect(sentPattern()).toBe(RBAC_PATTERNS.GET_USER_ROLES);
      expect(sentPayload()).toMatchObject({ userId: 'user-1' });
    });
  });
});
