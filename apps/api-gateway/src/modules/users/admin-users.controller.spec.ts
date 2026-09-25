import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { AdminUsersController } from './admin-users.controller';
import type { UsersService } from './users.service';
import { REQUIRED_PERMISSIONS } from '../rbac/rbac.guard';
import type { RequestUser } from '../auth/jwt-auth.guard';

const ADMIN: RequestUser = { id: 'admin-1', roles: ['ADMIN'], tokenId: 'jti' };

describe('AdminUsersController', () => {
  let users: jest.Mocked<UsersService>;
  let controller: AdminUsersController;

  const request = { headers: {}, id: 'req-1' } as unknown as FastifyRequest;

  beforeEach(() => {
    users = {
      listUsers: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    } as unknown as jest.Mocked<UsersService>;

    controller = new AdminUsersController(users);
  });

  /**
   * This is the one users route whose rule a decorator can express — the
   * others turn on whether the target happens to be the caller. Asserting the
   * metadata is the only way a unit test can see that the route is guarded at
   * all.
   */
  it('declares users@list on the controller', () => {
    expect(
      new Reflector().get<string[]>(REQUIRED_PERMISSIONS, AdminUsersController),
    ).toEqual(['users@list']);
  });

  it('passes the caller from the token, never from the query', async () => {
    await controller.listUsers({}, ADMIN, request);

    expect(users.listUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        viewerUserId: ADMIN.id,
        viewerRoles: ADMIN.roles,
      }),
    );
  });

  it('forwards every filter it was given', async () => {
    await controller.listUsers(
      {
        cursor: 'abc',
        limit: 50,
        q: 'ada',
        status: 'locked',
        sort: 'last_login',
        order: 'asc',
      },
      ADMIN,
      request,
    );

    expect(users.listUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: 'abc',
        limit: 50,
        q: 'ada',
        status: 'locked',
        sort: 'last_login',
        order: 'asc',
      }),
    );
  });

  /** Undefined rather than a gateway-invented default — identity owns those. */
  it('leaves absent filters absent', async () => {
    await controller.listUsers({}, ADMIN, request);

    const sent = users.listUsers.mock.calls[0][0];

    expect(sent.limit).toBeUndefined();
    expect(sent.sort).toBeUndefined();
    expect(sent.status).toBeUndefined();
  });

  it('returns the page as identity shaped it', async () => {
    users.listUsers.mockResolvedValue({
      items: [{ id: 'a' }],
      nextCursor: 'next',
    } as Awaited<ReturnType<UsersService['listUsers']>>);

    await expect(controller.listUsers({}, ADMIN, request)).resolves.toEqual({
      items: [{ id: 'a' }],
      nextCursor: 'next',
    });
  });
});
