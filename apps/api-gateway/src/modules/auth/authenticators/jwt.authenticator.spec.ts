import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { ACCESS_TOKEN_COOKIE } from '../session-cookies.service';
import { JwtAuthenticator } from './jwt.authenticator';

function requestWith({
  headers = {},
  cookies = {},
}: {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
} = {}): FastifyRequest {
  return { headers, cookies } as unknown as FastifyRequest;
}

describe('JwtAuthenticator', () => {
  let jwt: jest.Mocked<Pick<JwtService, 'verifyAsync'>>;
  let authenticator: JwtAuthenticator;

  beforeEach(() => {
    jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        roles: ['USER'],
        jti: 'jti-1',
      }),
    };

    authenticator = new JwtAuthenticator(jwt as unknown as JwtService);
    jest
      .spyOn(authenticator['logger'], 'warn')
      .mockImplementation(() => undefined);
  });

  describe('finding the token', () => {
    it('reads the access cookie — how a browser authenticates here', async () => {
      await expect(
        authenticator.authenticate(
          requestWith({ cookies: { [ACCESS_TOKEN_COOKIE]: 'from-cookie' } }),
        ),
      ).resolves.toEqual({ id: 'user-1', roles: ['USER'], tokenId: 'jti-1' });

      expect(jwt.verifyAsync).toHaveBeenCalledWith('from-cookie');
    });

    it('falls back to a bearer header, for callers that are not browsers', async () => {
      await authenticator.authenticate(
        requestWith({ headers: { authorization: 'Bearer from-header' } }),
      );

      expect(jwt.verifyAsync).toHaveBeenCalledWith('from-header');
    });

    it('prefers the cookie when a request carries both', async () => {
      await authenticator.authenticate(
        requestWith({
          cookies: { [ACCESS_TOKEN_COOKIE]: 'from-cookie' },
          headers: { authorization: 'Bearer from-header' },
        }),
      );

      expect(jwt.verifyAsync).toHaveBeenCalledWith('from-cookie');
    });

    it('accepts the scheme case-insensitively', async () => {
      await authenticator.authenticate(
        requestWith({ headers: { authorization: 'bearer good' } }),
      );

      expect(jwt.verifyAsync).toHaveBeenCalledWith('good');
    });
  });

  /**
   * "Not mine" is not a refusal: another authenticator may recognise the
   * request, and it is the guard, not this, that decides nobody did.
   */
  describe('a request with nothing it recognises', () => {
    it.each([
      ['no credentials at all', requestWith()],
      [
        'a different scheme',
        requestWith({ headers: { authorization: 'Basic abc' } }),
      ],
      [
        'a bearer header with no token',
        requestWith({ headers: { authorization: 'Bearer' } }),
      ],
      [
        'an empty cookie',
        requestWith({ cookies: { [ACCESS_TOKEN_COOKIE]: '' } }),
      ],
    ])('passes on %s, without verifying anything', async (_label, request) => {
      await expect(authenticator.authenticate(request)).resolves.toBeNull();
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
    });
  });

  /**
   * A bad token of *this* kind must stop the chain. Falling through would let
   * a forged cookie be followed by whatever a later scheme accepts.
   */
  describe('a token it recognises but rejects', () => {
    it('refuses one that fails verification', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('bad signature'));

      await expect(
        authenticator.authenticate(
          requestWith({ headers: { authorization: 'Bearer forged' } }),
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: ERROR_CODES.UNAUTHENTICATED,
          httpStatus: 401,
        }),
      );
    });

    /** A client should refresh, not send the user back to a login form. */
    it('distinguishes an expired token from an invalid one', async () => {
      const expired = new Error('jwt expired');
      expired.name = 'TokenExpiredError';
      jwt.verifyAsync.mockRejectedValue(expired);

      await expect(
        authenticator.authenticate(
          requestWith({ cookies: { [ACCESS_TOKEN_COOKIE]: 'stale' } }),
        ),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.TOKEN_EXPIRED }),
      );
    });

    it('does not fall back to the header when the cookie is bad', async () => {
      jwt.verifyAsync.mockRejectedValueOnce(new Error('bad signature'));

      await expect(
        authenticator.authenticate(
          requestWith({
            cookies: { [ACCESS_TOKEN_COOKIE]: 'forged' },
            headers: { authorization: 'Bearer good' },
          }),
        ),
      ).rejects.toThrow(
        expect.objectContaining({ code: ERROR_CODES.UNAUTHENTICATED }),
      );
      expect(jwt.verifyAsync).toHaveBeenCalledTimes(1);
    });

    it('logs the reason, never the token', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('bad signature'));

      await authenticator
        .authenticate(
          requestWith({ headers: { authorization: 'Bearer secret-token' } }),
        )
        .catch(() => undefined);

      expect(authenticator['logger'].warn).toHaveBeenCalledWith({
        event: 'auth.token.rejected',
        reason: 'invalid',
      });
    });
  });

  /**
   * docs/AUTHORIZATION.md §1.3.1: `sub` must be present. A genuine signature
   * on a token naming nobody used to pass, and carried an undefined user id
   * into identity — whose validation turned it into a 500.
   */
  it.each([
    ['no sub at all', { roles: ['ADMIN'], jti: 'jti-1' }],
    ['an empty sub', { sub: '', roles: ['ADMIN'], jti: 'jti-1' }],
    ['a sub that is not a string', { sub: 42, roles: ['ADMIN'], jti: 'jti-1' }],
  ])('refuses a genuine token with %s', async (_label, claims) => {
    jwt.verifyAsync.mockResolvedValue(claims);

    await expect(
      authenticator.authenticate(
        requestWith({ headers: { authorization: 'Bearer signed' } }),
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        code: ERROR_CODES.UNAUTHENTICATED,
        httpStatus: 401,
      }),
    );
  });

  /**
   * A token with no `roles` claim would otherwise yield `undefined`, and the
   * evaluator would crash rather than deny. It must become "no roles".
   */
  it('treats a token with no roles claim as holding none', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1' });

    const user = await authenticator.authenticate(
      requestWith({ headers: { authorization: 'Bearer odd' } }),
    );

    expect(user?.roles).toEqual([]);
  });
});
