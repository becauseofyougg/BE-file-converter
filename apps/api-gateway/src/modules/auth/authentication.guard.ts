import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { IS_PUBLIC } from '@core/auth/public.decorator';
import { AppError } from '@core/errors/app-error';
import { AUTHENTICATORS, type Authenticator } from './authenticator';
import type { AuthenticatedRequest } from './request-user';

/**
 * Authenticates every request that is not `@Public()` — the first of the two
 * global guards, before RBAC.
 *
 * It knows no scheme. It walks {@link AUTHENTICATORS} in order and takes the
 * first one that recognises the request; how each one proves anything is its
 * own business. See `authenticator.ts` for what the three possible answers
 * mean — in particular why a *refusal* stops the walk rather than moving on.
 *
 * Fails closed: an empty list, or a list none of which recognise the request,
 * is a 401 — never a pass.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    @Inject(AUTHENTICATORS)
    private readonly authenticators: readonly Authenticator[],
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // RPC and event handlers are authenticated by the broker connection, not
    // by a caller credential; this guard is for HTTP.
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    for (const authenticator of this.authenticators) {
      // Awaited in turn, not in parallel: order is precedence, and a later
      // scheme must not even be consulted once an earlier one has refused.
      const user = await authenticator.authenticate(request);

      if (user) {
        request.user = user;

        return true;
      }
    }

    throw new AppError(
      ERROR_CODES.UNAUTHENTICATED,
      'Authentication is required',
      401,
    );
  }
}
