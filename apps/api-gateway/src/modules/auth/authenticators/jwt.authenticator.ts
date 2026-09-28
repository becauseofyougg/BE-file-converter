import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { AccessTokenClaims } from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import type { Authenticator } from '../authenticator';
import type { RequestUser } from '../request-user';
import { ACCESS_TOKEN_COOKIE, readCookie } from '../session-cookies.service';

/**
 * The access token identity issues — docs/AUTHORIZATION.md §3.
 *
 * Verification is local: the token is signed with a secret both services hold,
 * so proving it is genuine needs no call to identity. That is the whole reason
 * the roles travel inside it — see docs/RBAC.md §1.3.1.
 *
 * The requirement also lists "load the user and check their status" as part of
 * this step. Doing that here would put a database round trip on every single
 * request and make the token's self-contained claims pointless; it happens at
 * refresh instead, at most one access-token lifetime away — see
 * docs/AUTHORIZATION.md §4 for that trade in full.
 *
 * This and identity's `JwtTokenIssuer` are the only two places that know the
 * access token is a JWT.
 */
@Injectable()
export class JwtAuthenticator implements Authenticator {
  private readonly logger = new Logger(JwtAuthenticator.name);

  constructor(private readonly jwt: JwtService) {}

  async authenticate(request: FastifyRequest): Promise<RequestUser | null> {
    const token = accessToken(request);

    // Nothing of ours on the request: not a refusal, just not our business.
    if (!token) {
      return null;
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

    return {
      id: claims.sub,
      roles: Array.isArray(claims.roles) ? claims.roles : [],
      tokenId: claims.jti,
    };
  }
}

/**
 * The cookie first, because that is how a browser authenticates here and the
 * token is never handed to the page in a body.
 *
 * `Authorization: Bearer` stays as a fallback for callers that are not
 * browsers — scripts, integration tests, anything driving the API directly.
 * It weakens nothing: an attacker who could build that header would need to
 * have read the cookie first, which `httpOnly` is what prevents.
 */
function accessToken(request: FastifyRequest): string | null {
  return readCookie(request, ACCESS_TOKEN_COOKIE) ?? bearerToken(request);
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;

  if (!header) {
    return null;
  }

  const [scheme, value] = header.split(' ');

  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
