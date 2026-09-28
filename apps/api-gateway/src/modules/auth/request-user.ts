import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Who is calling, as every consumer past authentication sees it.
 *
 * This is the whole of what the RBAC guard, the controllers and the rate
 * limiters know about a caller — deliberately nothing about *how* they proved
 * it. An `Authenticator` produces one; everything downstream reads one.
 */
export interface RequestUser {
  id: string;
  roles: string[];
  /**
   * Identifies the credential the caller presented, for audit lines. A JWT's
   * `jti` today; whatever uniquely names the credential in another scheme.
   */
  tokenId: string;
}

export interface AuthenticatedRequest extends FastifyRequest {
  user?: RequestUser;
}

/** Injects the authenticated caller, or `undefined` on a `@Public()` route. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
