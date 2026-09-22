import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma-clients/identity';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  REFRESH_TOKEN_TYPE,
  type AccessTokenClaims,
  type RefreshTokenClaims,
  type TokenPair,
} from '@contracts/messages/identity.messages';
import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import { IdentityConfig } from '../../config/identity.config';

export interface SessionContext {
  userAgent?: string;
  ip?: string;
}

/**
 * Issues and verifies the two tokens of a session.
 *
 * **Nothing is persisted.** docs/AUTHORIZATION.md §1 forbids a server-side
 * record of a refresh token — no allowlist, no denylist, no `jti` table, no
 * session row. A refresh token is therefore valid for its full lifetime and
 * cannot be recalled; the consequences, and the two things that still limit
 * the damage, are §5 of that document.
 */
@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<IdentityConfig>,
  ) {}

  /**
   * A fresh pair. Called on registration with confirmation off, on successful
   * confirmation, on login, and on every refresh — rotation is not a separate
   * path, it is this one called again.
   */
  async issuePair(user: User, roles: string[]): Promise<TokenPair> {
    // The roles are baked in, so the gateway needs no lookup per request. The
    // cost is that a revoked role keeps working until the token expires — see
    // docs/RBAC.md §1.3.1; `JWT_ACCESS_TTL` is the size of that window.
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      roles,
      jti: randomUUID(),
    } satisfies AccessTokenClaims);

    const refreshToken = await this.jwt.signAsync(
      {
        sub: user.id,
        jti: randomUUID(),
        typ: REFRESH_TOKEN_TYPE,
      } satisfies RefreshTokenClaims,
      {
        secret: this.refreshSecret(),
        expiresIn: `${this.refreshTtlDays()}d`,
      },
    );

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: this.accessExpiry().toISOString(),
      refreshTokenExpiresAt: this.refreshExpiry().toISOString(),
    };
  }

  /**
   * Signature, expiry and type — the whole of it, because there is no stored
   * state left to check against (§1.3.2 of the requirement is explicit that a
   * refresh carries no further server-side verification).
   */
  async verifyRefresh(token: string): Promise<RefreshTokenClaims> {
    let claims: RefreshTokenClaims;

    try {
      claims = await this.jwt.verifyAsync<RefreshTokenClaims>(token, {
        secret: this.refreshSecret(),
      });
    } catch (error) {
      this.logger.warn({
        event: 'auth.refresh.rejected',
        // The reason, never the token: a log aggregator is not a place to
        // leave a credential that is good for the next thirty days.
        reason:
          error instanceof Error && error.name === 'TokenExpiredError'
            ? 'expired'
            : 'invalid',
      });

      throw refreshRejected();
    }

    // Belt and braces next to the separate secret: an access token presented
    // here must not buy a new 30-day session.
    if (claims.typ !== REFRESH_TOKEN_TYPE || !claims.sub) {
      this.logger.warn({
        event: 'auth.refresh.rejected',
        reason: 'wrong_type',
      });

      throw refreshRejected();
    }

    return claims;
  }

  private refreshSecret(): string {
    return this.config.get('JWT_REFRESH_SECRET');
  }

  private refreshTtlDays(): number {
    return this.config.getNumber('REFRESH_TOKEN_TTL_DAYS');
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.refreshTtlDays() * 24 * 60 * 60 * 1000);
  }

  private accessExpiry(): Date {
    return new Date(
      Date.now() + parseDuration(this.config.get('JWT_ACCESS_TTL')),
    );
  }
}

/**
 * One answer for every way a refresh can fail. A client's only useful reaction
 * is to log in again, and distinguishing "expired" from "forged" would tell
 * someone probing with a stolen token which half of their guess was right.
 */
function refreshRejected(): AppError {
  return new AppError(
    ERROR_CODES.UNAUTHENTICATED,
    'The session has expired; sign in again',
    401,
  );
}

/**
 * `15m` / `24h` / `30d` / `900s`, matching what `jsonwebtoken` accepts for
 * `expiresIn`, so the TTL is configured once and means the same thing to both
 * the signer and the expiry we report to the client.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());

  if (!match) {
    throw new Error(`Unsupported duration: ${value}`);
  }

  const amount = Number(match[1]);

  switch (match[2]) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    case 'd':
      return amount * 24 * 60 * 60 * 1000;
    case 'm':
    default:
      return amount * 60 * 1000;
  }
}
