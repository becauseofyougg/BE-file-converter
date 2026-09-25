import type { FastifyReply, FastifyRequest } from 'fastify';

import type { TokenPair } from '@contracts/messages/identity.messages';
import { ConfigService } from '@core/config/config.service';

import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SessionCookiesService,
  readCookie,
} from './session-cookies.service';

describe('SessionCookiesService', () => {
  let setCookie: jest.Mock;
  let clearCookie: jest.Mock;
  let reply: FastifyReply;

  function build(config: Record<string, string | boolean> = {}) {
    const values: Record<string, unknown> = {
      COOKIE_SECURE: false,
      COOKIE_SAMESITE: 'strict',
      ...config,
    };

    return new SessionCookiesService({
      get: (key: string) => values[key] as string,
      getBoolean: (key: string) => values[key] === true,
    } as unknown as ConfigService<never>);
  }

  const tokens = (overrides: Partial<TokenPair> = {}): TokenPair => ({
    accessToken: 'access-jwt',
    refreshToken: 'refresh-jwt',
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 2_592_000_000).toISOString(),
    ...overrides,
  });

  const optionsFor = (name: string) =>
    setCookie.mock.calls.find((call) => call[0] === name)?.[2] as Record<
      string,
      unknown
    >;

  beforeEach(() => {
    setCookie = jest.fn().mockReturnThis();
    clearCookie = jest.fn().mockReturnThis();
    reply = { setCookie, clearCookie } as unknown as FastifyReply;
  });

  describe('issue', () => {
    it('writes both tokens as cookies and neither in the body', () => {
      build().issue(reply, tokens());

      expect(setCookie).toHaveBeenCalledWith(
        ACCESS_TOKEN_COOKIE,
        'access-jwt',
        expect.any(Object),
      );
      expect(setCookie).toHaveBeenCalledWith(
        REFRESH_TOKEN_COOKIE,
        'refresh-jwt',
        expect.any(Object),
      );
    });

    /**
     * A script injected into the page cannot read these, which is the whole
     * trade the cookie scheme makes.
     */
    it('makes both httpOnly', () => {
      build().issue(reply, tokens());

      expect(optionsFor(ACCESS_TOKEN_COOKIE)).toMatchObject({
        httpOnly: true,
      });
      expect(optionsFor(REFRESH_TOKEN_COOKIE)).toMatchObject({
        httpOnly: true,
      });
    });

    /**
     * The refresh cookie is scoped to `/auth`, so it never rides along on an
     * ordinary API call and never lands in a proxy log for one.
     */
    it('scopes the refresh cookie to /auth and the access cookie to /', () => {
      build().issue(reply, tokens());

      expect(optionsFor(ACCESS_TOKEN_COOKIE)).toMatchObject({ path: '/' });
      expect(optionsFor(REFRESH_TOKEN_COOKIE)).toMatchObject({
        path: '/auth',
      });
    });

    /** Sized from the token itself, so the two cannot drift apart. */
    it('sizes each maxAge from its own token expiry', () => {
      build().issue(reply, tokens());

      expect(optionsFor(ACCESS_TOKEN_COOKIE).maxAge).toBeCloseTo(900, -1);
      expect(optionsFor(REFRESH_TOKEN_COOKIE).maxAge).toBeCloseTo(
        2_592_000,
        -2,
      );
    });

    /** A negative maxAge tells the browser to delete the cookie. */
    it('floors an already-past expiry at zero', () => {
      build().issue(
        reply,
        tokens({
          accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );

      expect(optionsFor(ACCESS_TOKEN_COOKIE).maxAge).toBe(0);
    });

    it('carries the configured SameSite and Secure', () => {
      build({ COOKIE_SECURE: true, COOKIE_SAMESITE: 'none' }).issue(
        reply,
        tokens(),
      );

      expect(optionsFor(ACCESS_TOKEN_COOKIE)).toMatchObject({
        secure: true,
        sameSite: 'none',
      });
    });

    /** Unset means "this host only", which is the safer of the two. */
    it('omits the domain entirely when none is configured', () => {
      build().issue(reply, tokens());

      expect('domain' in optionsFor(ACCESS_TOKEN_COOKIE)).toBe(false);
    });

    it('sets the domain when one is configured', () => {
      build({ COOKIE_DOMAIN: 'example.com' }).issue(reply, tokens());

      expect(optionsFor(ACCESS_TOKEN_COOKIE)).toMatchObject({
        domain: 'example.com',
      });
    });
  });

  describe('clear', () => {
    /**
     * A browser treats a clear with a different path as a cookie it has never
     * heard of, and leaves the real one in place.
     */
    it('clears each cookie at the path it was written to', () => {
      build().clear(reply);

      expect(clearCookie).toHaveBeenCalledWith(
        ACCESS_TOKEN_COOKIE,
        expect.objectContaining({ path: '/' }),
      );
      expect(clearCookie).toHaveBeenCalledWith(
        REFRESH_TOKEN_COOKIE,
        expect.objectContaining({ path: '/auth' }),
      );
    });

    it('repeats the domain, or the clear would not match', () => {
      build({ COOKIE_DOMAIN: 'example.com' }).clear(reply);

      expect(clearCookie).toHaveBeenCalledWith(
        ACCESS_TOKEN_COOKIE,
        expect.objectContaining({ domain: 'example.com' }),
      );
    });
  });
});

describe('readCookie', () => {
  const requestWith = (cookies?: Record<string, string>) =>
    ({ cookies }) as unknown as FastifyRequest;

  it('returns the value when it is there', () => {
    expect(readCookie(requestWith({ a: 'b' }), 'a')).toBe('b');
  });

  it('returns undefined for a missing one', () => {
    expect(readCookie(requestWith({}), 'a')).toBeUndefined();
  });

  /** An empty cookie is not a credential; treating it as one invites a 500. */
  it('treats an empty value as absent', () => {
    expect(readCookie(requestWith({ a: '' }), 'a')).toBeUndefined();
  });

  it('survives a request with no cookies at all', () => {
    expect(readCookie(requestWith(), 'a')).toBeUndefined();
  });
});
