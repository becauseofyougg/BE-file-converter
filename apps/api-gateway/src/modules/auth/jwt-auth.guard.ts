import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { AccessTokenClaims } from '@contracts/messages/identity.messages';
import { IS_PUBLIC, Public } from '@core/auth/public.decorator';
import { AppError } from '@core/errors/app-error';

export { Public };

export interface RequestUser {
  id: string;
  roles: string[];
  tokenId: string;
}

/** Injects the authenticated caller, or `undefined` on a `@Public()` route. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

export interface AuthenticatedRequest extends FastifyRequest {
  user?: RequestUser;
}

/**
 * Verifies the access token and attaches the caller to the request.
 *
 * Verification is local: the token is signed with a secret both services hold,
 * so proving it is genuine needs no call to identity. That is the whole reason
 * the roles travel inside it — see docs/RBAC.md §1.3.1.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    const token = bearerToken(request);

    if (!token) {
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'Authentication is required',
        401,
      );
    }

    let claims: AccessTokenClaims;

    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
    } catch (error) {
      // Expired is worth its own code: a client should refresh rather than
      // send the user back to a login form.
      const expired =
        error instanceof Error && error.name === 'TokenExpiredError';

      this.logger.warn({
        event: 'auth.token.rejected',
        reason: expired ? 'expired' : 'invalid',
      });

      throw new AppError(
        expired ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.UNAUTHENTICATED,
        expired
          ? 'The access token has expired'
          : 'The access token is invalid',
        401,
      );
    }

    request.user = {
      id: claims.sub,
      roles: Array.isArray(claims.roles) ? claims.roles : [],
      tokenId: claims.jti,
    };

    return true;
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;

  if (!header) {
    return null;
  }

  const [scheme, value] = header.split(' ');

  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
