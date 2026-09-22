import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type {
  PermissionRef,
  RbacConfig,
} from '@contracts/messages/rbac.messages';
import { AppError } from '@core/errors/app-error';
import { emptyRbacConfig } from '@core/rbac/rbac-policy';
import type { RequestUser } from '../auth/jwt-auth.guard';
import { RbacConfigCache } from './rbac-config.cache';
import { RbacGuard } from './rbac.guard';

const config: RbacConfig = {
  version: 'test',
  generatedAt: new Date().toISOString(),
  permissions: [
    { name: 'rbac', actions: ['read', 'manage'] },
    { name: 'users', actions: ['read', 'delete'] },
  ],
  roles: [
    { name: 'USER', grants: [{ permission: 'users', actions: ['read'] }] },
    {
      name: 'ADMIN',
      grants: [
        { permission: 'rbac', actions: [] },
        { permission: 'users', actions: [] },
      ],
    },
  ],
};

function contextFor(user?: RequestUser): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ user, url: '/admin/rbac/roles' }),
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('RbacGuard', () => {
  let cache: jest.Mocked<Pick<RbacConfigCache, 'current'>>;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  let guard: RbacGuard;

  const admin: RequestUser = {
    id: 'user-1',
    roles: ['ADMIN'],
    tokenId: 'jti-1',
  };
  const plain: RequestUser = {
    id: 'user-2',
    roles: ['USER'],
    tokenId: 'jti-2',
  };

  beforeEach(() => {
    cache = { current: jest.fn().mockReturnValue(config) };
    reflector = { getAllAndOverride: jest.fn() };

    guard = new RbacGuard(
      cache as unknown as RbacConfigCache,
      reflector as unknown as Reflector,
    );
  });

  const requiring = (...permissions: PermissionRef[]) =>
    reflector.getAllAndOverride.mockReturnValue(permissions);

  it('allows a caller whose role grants the permission', () => {
    requiring('rbac@manage');

    expect(guard.canActivate(contextFor(admin))).toBe(true);
  });

  it('refuses a caller whose role does not', () => {
    requiring('rbac@manage');

    expect(() => guard.canActivate(contextFor(plain))).toThrow(
      expect.objectContaining({ code: ERROR_CODES.FORBIDDEN }),
    );
  });

  /**
   * The reason describes the shape of the config; handing it to whoever is
   * probing would map it out for them.
   */
  it('tells the client nothing beyond "denied"', () => {
    requiring('rbac@manage');
    expect.assertions(3);

    try {
      guard.canActivate(contextFor(plain));
    } catch (error) {
      const denial = error as AppError;

      expect(denial.httpStatus).toBe(403);
      expect(denial.message).toBe('Access denied');
      expect(denial.details).toBeUndefined();
    }
  });

  it('lets a route that declares no permission through', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined as never);

    expect(guard.canActivate(contextFor(plain))).toBe(true);
  });

  it('requires every declared permission, not just one', () => {
    requiring('users@read', 'rbac@manage');

    expect(() => guard.canActivate(contextFor(plain))).toThrow(AppError);
    expect(guard.canActivate(contextFor(admin))).toBe(true);
  });

  it('answers 401 rather than 403 when nobody is authenticated', () => {
    requiring('rbac@manage');

    try {
      guard.canActivate(contextFor(undefined));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as AppError).httpStatus).toBe(401);
      expect((error as AppError).code).toBe(ERROR_CODES.UNAUTHENTICATED);
    }
  });

  /** A malformed declaration is a deployment bug; it must not open the route. */
  it('denies a malformed permission reference instead of ignoring it', () => {
    requiring('rbac' as PermissionRef);

    expect(() => guard.canActivate(contextFor(admin))).toThrow(
      expect.objectContaining({ code: ERROR_CODES.FORBIDDEN }),
    );
  });

  /**
   * The window between a gateway starting and identity answering. Denying is
   * the only safe reading — the alternative is a few seconds of open doors.
   */
  it('denies everything while the config has not loaded', () => {
    cache.current.mockReturnValue(emptyRbacConfig());
    requiring('rbac@manage');

    expect(() => guard.canActivate(contextFor(admin))).toThrow(AppError);
  });

  it('skips non-HTTP contexts, which carry no request to decide on', () => {
    const rpc = {
      getType: () => 'rpc',
    } as unknown as ExecutionContext;

    expect(guard.canActivate(rpc)).toBe(true);
  });
});
