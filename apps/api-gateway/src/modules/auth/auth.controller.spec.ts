import type { FastifyReply, FastifyRequest } from 'fastify';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { TokenPair } from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';

import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import { REFRESH_TOKEN_COOKIE } from './session-cookies.service';
import type { SessionCookiesService } from './session-cookies.service';

const TOKENS: TokenPair = {
  accessToken: 'access-jwt',
  refreshToken: 'refresh-jwt',
  accessTokenExpiresAt: '2026-01-01T00:15:00.000Z',
  refreshTokenExpiresAt: '2026-01-31T00:00:00.000Z',
};

describe('gateway AuthController', () => {
  let auth: jest.Mocked<AuthService>;
  let cookies: jest.Mocked<SessionCookiesService>;
  let reply: { status: jest.Mock };
  let controller: AuthController;

  const requestWith = (cookiesOnRequest: Record<string, string> = {}) =>
    ({
      headers: {},
      id: 'req-1',
      cookies: cookiesOnRequest,
    }) as unknown as FastifyRequest;

  const asReply = () => reply as unknown as FastifyReply;

  beforeEach(() => {
    auth = {
      register: jest.fn(),
      login: jest.fn(),
      confirmLogin: jest.fn(),
      verifyEmail: jest.fn(),
      refresh: jest.fn(),
      resendVerification: jest.fn().mockResolvedValue({ status: 'accepted' }),
      resendLoginConfirmation: jest
        .fn()
        .mockResolvedValue({ status: 'accepted' }),
    } as unknown as jest.Mocked<AuthService>;

    cookies = {
      issue: jest.fn(),
      clear: jest.fn(),
    } as unknown as jest.Mocked<SessionCookiesService>;

    reply = { status: jest.fn().mockReturnThis() };
    controller = new AuthController(auth, cookies);
  });

  describe('register', () => {
    it('answers 201 and sets the cookies when a session came back', async () => {
      auth.register.mockResolvedValue({
        status: 'registered',
        userId: 'user-1',
        tokens: TOKENS,
      });

      const body = await controller.register(
        { email: 'a@b.c', password: 'a long passphrase' },
        requestWith(),
        asReply(),
      );

      expect(reply.status).toHaveBeenCalledWith(201);
      expect(cookies.issue).toHaveBeenCalledWith(asReply(), TOKENS);
      expect(body).toMatchObject({
        status: 'registered',
        accessTokenExpiresAt: TOKENS.accessTokenExpiresAt,
      });
    });

    /** Neither token is ever in the body — that is the point of the scheme. */
    it('puts no token in the body', async () => {
      auth.register.mockResolvedValue({
        status: 'registered',
        userId: 'user-1',
        tokens: TOKENS,
      });

      const body = await controller.register(
        { email: 'a@b.c', password: 'a long passphrase' },
        requestWith(),
        asReply(),
      );

      expect(JSON.stringify(body)).not.toContain('access-jwt');
      expect(JSON.stringify(body)).not.toContain('refresh-jwt');
    });

    it('answers 202 and no cookies when confirmation is required', async () => {
      auth.register.mockResolvedValue({
        status: 'confirmation_required',
        challengeId: 'challenge-1',
        expiresAt: 'later',
      });

      const body = await controller.register(
        { email: 'a@b.c', password: 'a long passphrase' },
        requestWith(),
        asReply(),
      );

      expect(reply.status).toHaveBeenCalledWith(202);
      expect(cookies.issue).not.toHaveBeenCalled();
      expect(body).toMatchObject({ status: 'confirmation_required' });
    });
  });

  describe('login', () => {
    it('sets the cookies on a completed sign-in', async () => {
      auth.login.mockResolvedValue({
        status: 'authenticated',
        userId: 'user-1',
        tokens: TOKENS,
      });

      await controller.login(
        { email: 'a@b.c', password: 'x' },
        requestWith(),
        asReply(),
      );

      expect(cookies.issue).toHaveBeenCalledWith(asReply(), TOKENS);
    });

    it('answers 202 with the challenge when confirmation is on', async () => {
      auth.login.mockResolvedValue({
        status: 'confirmation_required',
        challengeId: 'challenge-1',
        expiresAt: 'later',
      });

      const body = await controller.login(
        { email: 'a@b.c', password: 'x' },
        requestWith(),
        asReply(),
      );

      expect(reply.status).toHaveBeenCalledWith(202);
      expect(body).toMatchObject({ challengeId: 'challenge-1' });
    });
  });

  describe('refresh', () => {
    it('reads the refresh token from the cookie, not the body', async () => {
      auth.refresh.mockResolvedValue({
        status: 'refreshed',
        userId: 'user-1',
        tokens: TOKENS,
      });

      await controller.refresh(
        requestWith({ [REFRESH_TOKEN_COOKIE]: 'refresh-jwt' }),
        asReply(),
      );

      expect(auth.refresh).toHaveBeenCalledWith(
        'refresh-jwt',
        expect.any(Object),
      );
    });

    it('replaces both cookies, because rotation is the whole point', async () => {
      auth.refresh.mockResolvedValue({
        status: 'refreshed',
        userId: 'user-1',
        tokens: TOKENS,
      });

      await controller.refresh(
        requestWith({ [REFRESH_TOKEN_COOKIE]: 'refresh-jwt' }),
        asReply(),
      );

      expect(cookies.issue).toHaveBeenCalledWith(asReply(), TOKENS);
    });

    /**
     * "You have no cookie" and "your cookie is no good" lead a client to the
     * same place: the login form.
     */
    it('answers 401 when there is no cookie, without calling identity', async () => {
      const error = (await controller
        .refresh(requestWith(), asReply())
        .catch((caught: unknown) => caught)) as AppError;

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(ERROR_CODES.UNAUTHENTICATED);
      expect(auth.refresh).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    /**
     * The whole of a logout here: refresh tokens are not stored, so nothing
     * can be revoked server-side.
     */
    it('clears the cookies and calls nothing', () => {
      controller.logout(asReply());

      expect(cookies.clear).toHaveBeenCalledWith(asReply());
    });
  });

  describe('the always-202 endpoints', () => {
    it('resendVerification says nothing about the account', async () => {
      await expect(
        controller.resendVerification({ email: 'a@b.c' }, requestWith()),
      ).resolves.toEqual({ status: 'accepted' });
    });

    it('resendLoginConfirmation says nothing about the challenge', async () => {
      await expect(
        controller.resendLoginConfirmation(
          { challengeId: 'challenge-1' },
          requestWith(),
        ),
      ).resolves.toEqual({ status: 'accepted' });
    });
  });

  describe('verifyEmail', () => {
    it('signs the user in on success', async () => {
      auth.verifyEmail.mockResolvedValue({
        status: 'verified',
        userId: 'user-1',
        tokens: TOKENS,
      });

      const body = await controller.verifyEmail(
        { challengeId: 'c', code: '123456' },
        requestWith(),
        asReply(),
      );

      expect(cookies.issue).toHaveBeenCalledWith(asReply(), TOKENS);
      expect(body).toMatchObject({ status: 'verified' });
    });
  });
});
