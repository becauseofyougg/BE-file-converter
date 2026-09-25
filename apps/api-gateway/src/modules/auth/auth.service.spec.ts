import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';

import { IDENTITY_PATTERNS } from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';

import { AuthService, type CallerContext } from './auth.service';

const CALLER: CallerContext = {
  correlationId: 'correlation-1',
  userAgent: 'Mozilla/5.0',
  ip: '203.0.113.1',
};

describe('gateway AuthService', () => {
  let send: jest.Mock;
  let service: AuthService;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of({ status: 'ok' }));
    service = new AuthService({ send } as unknown as ClientProxy);
  });

  const payload = () => send.mock.calls[0][1] as Record<string, unknown>;

  describe('register', () => {
    it('sends the credentials with the caller context', async () => {
      await service.register(
        { email: 'a@b.c', password: 'a long passphrase' },
        CALLER,
      );

      expect(send).toHaveBeenCalledWith(
        IDENTITY_PATTERNS.REGISTER,
        expect.objectContaining({
          email: 'a@b.c',
          correlationId: 'correlation-1',
        }),
      );
    });
  });

  describe('login', () => {
    /**
     * The user agent and IP end up in the confirmation mail, so the owner can
     * recognise a sign-in that is not theirs.
     */
    it('carries the device details the confirmation mail needs', async () => {
      await service.login({ email: 'a@b.c', password: 'x' }, CALLER);

      expect(payload()).toMatchObject({
        userAgent: 'Mozilla/5.0',
        ip: '203.0.113.1',
      });
    });
  });

  describe('resendVerification', () => {
    /**
     * Deliberately narrower than the others: the resend is keyed on a
     * challenge the caller already proved it holds, and the device details
     * would only end up in a log.
     */
    it('sends only the identifier and the correlation id', async () => {
      await service.resendVerification({ email: 'a@b.c' }, CALLER);

      expect(payload()).toEqual({
        email: 'a@b.c',
        correlationId: 'correlation-1',
      });
    });
  });

  describe('refresh', () => {
    it('sends the token from the cookie, and nothing about the device', async () => {
      await service.refresh('a.b.c', CALLER);

      expect(send).toHaveBeenCalledWith(IDENTITY_PATTERNS.REFRESH, {
        refreshToken: 'a.b.c',
        correlationId: 'correlation-1',
      });
    });
  });

  describe('the remaining forwarders', () => {
    it.each([
      ['verifyEmail', IDENTITY_PATTERNS.VERIFY_EMAIL],
      ['confirmLogin', IDENTITY_PATTERNS.CONFIRM_LOGIN],
    ])('%s sends %s', async (method, pattern) => {
      await (
        service[method as 'verifyEmail'] as (
          input: object,
          caller: CallerContext,
        ) => Promise<unknown>
      )({ challengeId: 'c', code: '123456' }, CALLER);

      expect(send).toHaveBeenCalledWith(pattern, expect.any(Object));
    });

    it('resendLoginConfirmation sends just the challenge', async () => {
      await service.resendLoginConfirmation('challenge-1', CALLER);

      expect(send).toHaveBeenCalledWith(
        IDENTITY_PATTERNS.RESEND_LOGIN_CONFIRMATION,
        { challengeId: 'challenge-1', correlationId: 'correlation-1' },
      );
    });
  });

  /**
   * The gateway owns no auth logic of its own — putting any here would mean
   * two services deciding who may register, and the one that owns the data
   * losing. So a refusal must arrive intact.
   */
  it('lets an identity refusal through with its status', async () => {
    send.mockReturnValue(
      throwError(() => ({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        httpStatus: 401,
      })),
    );

    const error = (await service
      .login({ email: 'a@b.c', password: 'x' }, CALLER)
      .catch((caught: unknown) => caught)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.httpStatus).toBe(401);
  });
});
