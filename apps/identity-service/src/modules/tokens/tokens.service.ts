import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { User } from '@prisma-clients/identity';

import { ConfigService } from '@core/config/config.service';
import type {
  AccessTokenClaims,
  TokenPair,
} from '@contracts/messages/identity.messages';
import { IdentityConfig } from '../../config/identity.config';
import { PrismaService } from '../../database/prisma.service';

const REFRESH_TOKEN_BYTES = 32;

export interface SessionContext {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class TokensService {
  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<IdentityConfig>,
  ) {}

  private get db() {
    return this.txHost.tx;
  }

  /**
   * A signed access token plus a fresh refresh family. Called on registration
   * with confirmation off, on successful confirmation, and on login.
   */
  async issuePair(
    user: User,
    roles: string[],
    context: SessionContext = {},
  ): Promise<TokenPair> {
    // The roles are baked in, so the gateway needs no lookup per request. The
    // cost is that a revoked role keeps working until the token expires — see
    // docs/RBAC.md §1.3.1; `JWT_ACCESS_TTL` is the size of that window.
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      roles,
      jti: randomUUID(),
    } satisfies AccessTokenClaims);

    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

    await this.db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        familyId: randomUUID(),
        expiresAt: this.refreshExpiry(),
        revokedAt: null,
        userAgent: context.userAgent?.slice(0, 255) ?? null,
        ip: context.ip ?? null,
      },
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: this.accessExpiry().toISOString(),
    };
  }

  /** Every live token of a user, e.g. on password change. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private refreshExpiry(): Date {
    const days = this.config.getNumber('REFRESH_TOKEN_TTL_DAYS');

    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  private accessExpiry(): Date {
    return new Date(
      Date.now() + parseDuration(this.config.get('JWT_ACCESS_TTL')),
    );
  }
}

/**
 * The refresh token is random, so a plain digest is enough — there is no
 * low-entropy secret here for an attacker to grind offline.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
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
