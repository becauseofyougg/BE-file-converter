import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  parsePermissionRef,
  type PermissionRef,
} from '@contracts/messages/rbac.messages';
import { AppError } from '@core/errors/app-error';
import { decideAccess } from '@core/rbac/rbac-policy';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { RbacConfigCache } from './rbac-config.cache';

export const REQUIRED_PERMISSIONS = 'REQUIRED_PERMISSIONS';

/**
 * Declares what a route needs, as `resource@action`:
 *
 * ```ts
 * @Permissions('rbac@manage')
 * ```
 *
 * Several references mean **all** of them are required. "Any of these" is
 * deliberately not expressible: it reads the same at the call site and is the
 * kind of subtlety that turns into an accidental grant.
 */
export const Permissions = (...permissions: PermissionRef[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * Decides against the cached config. Runs after `JwtAuthGuard`, so the caller
 * and its roles are already on the request.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  private readonly logger = new Logger(RbacGuard.name);

  constructor(
    private readonly cache: RbacConfigCache,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const required = this.reflector.getAllAndOverride<PermissionRef[]>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );

    // A route that declares nothing is not implicitly protected by RBAC —
    // authentication alone is its bar. Making every route require a permission
    // would mean inventing one for `/users/me`.
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'Authentication is required',
        401,
      );
    }

    const config = this.cache.current();

    for (const reference of required) {
      const parsed = parsePermissionRef(reference);

      if (!parsed) {
        // A malformed declaration is a deployment bug. Deny and shout — the
        // alternative is a route that silently requires nothing.
        this.logger.error({
          event: 'rbac.permission.malformed',
          reference,
          route: request.url,
        });

        throw new AppError(ERROR_CODES.FORBIDDEN, 'Access denied', 403);
      }

      const decision = decideAccess(
        config,
        user.roles,
        parsed.resource,
        parsed.action,
      );

      if (!decision.allowed) {
        this.logger.warn({
          event: 'rbac.access.denied',
          userId: user.id,
          roles: user.roles,
          required: reference,
          reason: decision.reason,
          configVersion: config.version,
          route: request.url,
        });

        // The reason goes to the log, never to the client: "unknown_role" and
        // "no_grant" together describe the shape of the config to anyone
        // probing it.
        throw new AppError(ERROR_CODES.FORBIDDEN, 'Access denied', 403);
      }

      this.logger.debug({
        event: 'rbac.access.granted',
        userId: user.id,
        required: reference,
        grantedBy: decision.grantedBy,
        configVersion: config.version,
      });
    }

    return true;
  }
}
