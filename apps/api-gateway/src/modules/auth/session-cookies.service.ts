import { Injectable } from '@nestjs/common';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { TokenPair } from '@contracts/messages/identity.messages';
import { ConfigService } from '@core/config/config.service';
import { GatewayConfig } from '../../config/gateway.config';

export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * Where the refresh cookie is sent. Narrower than the access cookie on
 * purpose: `/auth/refresh` and `/auth/logout` are the only two endpoints with
 * any use for it, so it never rides along on an ordinary API call and never
 * appears in a proxy log for one.
 */
const REFRESH_COOKIE_PATH = '/auth';

/**
 * The one place that writes and clears the session cookies —
 * docs/AUTHORIZATION.md §3.
 *
 * Both tokens travel as `httpOnly` cookies and neither is ever returned in a
 * body. That is the whole trade: a script injected into the page cannot read
 * them (which `localStorage` cannot promise), at the cost of the browser
 * attaching them automatically, which is what `SameSite` is then for.
 */
@Injectable()
export class SessionCookiesService {
  constructor(private readonly config: ConfigService<GatewayConfig>) {}

  /** Writes both cookies, each expiring with the token inside it. */
  issue(reply: FastifyReply, tokens: TokenPair): void {
    void reply.setCookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
      ...this.baseOptions(),
      path: '/',
      maxAge: secondsUntil(tokens.accessTokenExpiresAt),
    });

    void reply.setCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      ...this.baseOptions(),
      path: REFRESH_COOKIE_PATH,
      maxAge: secondsUntil(tokens.refreshTokenExpiresAt),
    });
  }

  /**
   * Logout, in full. With no server-side record of a refresh token there is
   * nothing else to do — the tokens stay cryptographically valid until they
   * expire, and all this can do is stop the browser sending them. §5 is about
   * why that is the accepted consequence and not an oversight.
   *
   * The attributes must match what `issue` wrote, `path` and `domain`
   * included: a browser treats a clear with a different path as a cookie it has
   * never heard of and leaves the real one in place.
   */
  clear(reply: FastifyReply): void {
    void reply.clearCookie(ACCESS_TOKEN_COOKIE, {
      ...this.baseOptions(),
      path: '/',
    });

    void reply.clearCookie(REFRESH_TOKEN_COOKIE, {
      ...this.baseOptions(),
      path: REFRESH_COOKIE_PATH,
    });
  }

  private baseOptions(): CookieSerializeOptions {
    const domain = this.config.get('COOKIE_DOMAIN');

    return {
      httpOnly: true,
      secure: this.config.getBoolean('COOKIE_SECURE'),
      sameSite: this.config.get(
        'COOKIE_SAMESITE',
      ) as CookieSerializeOptions['sameSite'],
      // Unset means "this host only", which is the safer of the two and the
      // right answer whenever the API is not shared across subdomains.
      ...(domain ? { domain } : {}),
    };
  }
}

/** Reads a cookie by name; `undefined` when absent or empty. */
export function readCookie(
  request: FastifyRequest,
  name: string,
): string | undefined {
  return request.cookies?.[name] || undefined;
}

/**
 * `maxAge` is seconds in `Set-Cookie`, and the value comes from the token so
 * the cookie's lifetime and the token's `exp` cannot drift apart. Floored at
 * zero: a negative `maxAge` tells the browser to delete the cookie, which is
 * the opposite of what a caller of `issue` means.
 */
function secondsUntil(isoTimestamp: string): number {
  return Math.max(
    0,
    Math.floor((new Date(isoTimestamp).getTime() - Date.now()) / 1000),
  );
}
