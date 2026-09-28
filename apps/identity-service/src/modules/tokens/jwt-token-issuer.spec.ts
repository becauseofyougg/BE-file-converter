import { JwtService } from '@nestjs/jwt';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { AccessTokenClaims } from '@contracts/messages/identity.messages';
import { ConfigService } from '@core/config/config.service';
import type { AppError } from '@core/errors/app-error';
import type { User } from '../users/users.service';
import { TokensService, parseDuration } from './tokens.service';

const ACCESS_SECRET = 'access-secret-that-is-long-enough-for-joi';
const REFRESH_SECRET = 'refresh-secret-that-is-long-enough-x';

const CONFIG: Record<string, string> = {
  JWT_SECRET: ACCESS_SECRET,
  JWT_REFRESH_SECRET: REFRESH_SECRET,
  JWT_ACCESS_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: '30',
};

function buildUser(): User {
  return { id: 'user-1', email: 'user@example.com' } as User;
}

describe('TokensService', () => {
  let jwt: JwtService;
  let service: TokensService;

  beforeEach(() => {
    jwt = new JwtService({
      secret: ACCESS_SECRET,
      signOptions: { algorithm: 'HS256', expiresIn: '15m' },
    });

    const config = {
      get: (key: string) => CONFIG[key],
      getNumber: (key: string) => Number(CONFIG[key]),
    } as unknown as ConfigService<never>;

    service = new TokensService(jwt, config);
  });

  describe('issuePair', () => {
    it('signs the roles into the access token, so the gateway needs no lookup', async () => {
      const pair = await service.issuePair(buildUser(), ['USER', 'ADMIN']);

      const claims = jwt.verify<AccessTokenClaims>(pair.accessToken, {
        secret: ACCESS_SECRET,
      });

      expect(claims.sub).toBe('user-1');
      expect(claims.roles).toEqual(['USER', 'ADMIN']);
    });

    it('gives each expiry to the client, so a cookie can be sized from it', async () => {
      const pair = await service.issuePair(buildUser(), ['USER']);

      const accessMs =
        new Date(pair.accessTokenExpiresAt).getTime() - Date.now();
      const refreshMs =
        new Date(pair.refreshTokenExpiresAt).getTime() - Date.now();

      expect(accessMs).toBeGreaterThan(14 * 60 * 1000);
      expect(accessMs).toBeLessThanOrEqual(15 * 60 * 1000);
      expect(refreshMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    });

    it('carries no roles in the refresh token — it authorises nothing', async () => {
      const pair = await service.issuePair(buildUser(), ['ADMIN']);

      const claims = jwt.verify<Record<string, unknown>>(pair.refreshToken, {
        secret: REFRESH_SECRET,
      });

      expect(claims.roles).toBeUndefined();
      expect(claims.typ).toBe('refresh');
    });

    it('rotates: two pairs share no token', async () => {
      const first = await service.issuePair(buildUser(), ['USER']);
      const second = await service.issuePair(buildUser(), ['USER']);

      expect(second.refreshToken).not.toBe(first.refreshToken);
    });
  });

  describe('verifyRefresh', () => {
    it('accepts a refresh token it issued', async () => {
      const pair = await service.issuePair(buildUser(), ['USER']);

      await expect(service.verifyRefresh(pair.refreshToken)).resolves.toEqual(
        expect.objectContaining({ sub: 'user-1', typ: 'refresh' }),
      );
    });

    /**
     * The escalation this guards against: an access token is good for fifteen
     * minutes, and accepting one here would trade it for a thirty-day session.
     */
    it('refuses an access token presented as a refresh token', async () => {
      const pair = await service.issuePair(buildUser(), ['ADMIN']);

      await expect(service.verifyRefresh(pair.accessToken)).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.UNAUTHENTICATED }),
      );
    });

    it('refuses a token signed with the right shape but the wrong secret', async () => {
      const forged = jwt.sign(
        { sub: 'user-1', jti: 'x', typ: 'refresh' },
        { secret: 'a-different-secret-entirely-000000' },
      );

      await expect(service.verifyRefresh(forged)).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.UNAUTHENTICATED }),
      );
    });

    it('refuses an expired token', async () => {
      const expired = jwt.sign(
        { sub: 'user-1', jti: 'x', typ: 'refresh' },
        { secret: REFRESH_SECRET, expiresIn: '-1s' },
      );

      await expect(service.verifyRefresh(expired)).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.UNAUTHENTICATED }),
      );
    });

    /**
     * A client's only useful reaction to any of these is to log in again, and
     * telling a prober which half of their guess was wrong helps only them.
     */
    it('answers identically however it fails', async () => {
      const pair = await service.issuePair(buildUser(), ['USER']);
      const expired = jwt.sign(
        { sub: 'user-1', jti: 'x', typ: 'refresh' },
        { secret: REFRESH_SECRET, expiresIn: '-1s' },
      );

      const fromWrongType = (await service
        .verifyRefresh(pair.accessToken)
        .catch((error: AppError) => error)) as AppError;
      const fromExpiry = (await service
        .verifyRefresh(expired)
        .catch((error: AppError) => error)) as AppError;

      expect(fromWrongType.message).toBe(fromExpiry.message);
      expect(fromWrongType.httpStatus).toBe(fromExpiry.httpStatus);
    });
  });

  describe('parseDuration', () => {
    it.each([
      ['15m', 15 * 60 * 1000],
      ['24h', 24 * 60 * 60 * 1000],
      ['30d', 30 * 24 * 60 * 60 * 1000],
      ['900s', 900 * 1000],
      ['500ms', 500],
      // Bare numbers mean minutes, matching `jsonwebtoken`'s own default.
      ['15', 15 * 60 * 1000],
    ])('reads %s', (input, expected) => {
      expect(parseDuration(input)).toBe(expected);
    });

    it('refuses a duration it does not understand', () => {
      expect(() => parseDuration('a fortnight')).toThrow();
    });
  });
});
