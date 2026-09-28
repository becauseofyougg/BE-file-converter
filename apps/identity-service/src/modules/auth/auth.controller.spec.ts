import type { RmqContext } from '@nestjs/microservices';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';

import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { LoginService } from './login.service';
import type { RefreshService } from './refresh.service';

describe('identity AuthController', () => {
  let auth: jest.Mocked<AuthService>;
  let login: jest.Mocked<LoginService>;
  let refresh: jest.Mocked<RefreshService>;
  let ack: jest.Mock;
  let context: RmqContext;
  let controller: AuthController;

  const message = { fields: { deliveryTag: 1 } };

  beforeEach(() => {
    auth = {
      register: jest.fn().mockResolvedValue({ status: 'registered' }),
      verifyEmail: jest.fn().mockResolvedValue({ status: 'verified' }),
      resendVerification: jest.fn().mockResolvedValue({ status: 'accepted' }),
    } as unknown as jest.Mocked<AuthService>;

    login = {
      login: jest.fn().mockResolvedValue({ status: 'authenticated' }),
      confirmLogin: jest.fn().mockResolvedValue({ status: 'authenticated' }),
      resendConfirmation: jest.fn().mockResolvedValue({ status: 'accepted' }),
    } as unknown as jest.Mocked<LoginService>;

    refresh = {
      refresh: jest.fn().mockResolvedValue({ status: 'refreshed' }),
    } as unknown as jest.Mocked<RefreshService>;

    ack = jest.fn();
    context = {
      getChannelRef: () => ({ ack }),
      getMessage: () => message,
    } as unknown as RmqContext;

    controller = new AuthController(auth, login, refresh);
  });

  it('dispatches a registration, carrying the device details', async () => {
    await controller.register(
      {
        email: 'a@b.c',
        password: 'a long passphrase',
        correlationId: 'c',
        userAgent: 'Mozilla/5.0',
        ip: '203.0.113.1',
      },
      context,
    );

    expect(auth.register).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'a@b.c',
        session: { userAgent: 'Mozilla/5.0', ip: '203.0.113.1' },
      }),
    );
    expect(ack).toHaveBeenCalledWith(message);
  });

  it.each([
    ['verifyEmail', () => auth.verifyEmail],
    ['confirmLogin', () => login.confirmLogin],
  ])('%s dispatches a challenge submission', async (method, mockFor) => {
    await (
      controller[method as 'verifyEmail'] as (
        dto: object,
        context: RmqContext,
      ) => Promise<unknown>
    )({ challengeId: 'challenge-1', code: '123456' }, context);

    expect(mockFor()).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: 'challenge-1', code: '123456' }),
    );
  });

  it('dispatches a login', async () => {
    await controller.logIn({ email: 'a@b.c', password: 'x' }, context);

    expect(login.login).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.c' }),
    );
  });

  /** Read-only, so no transaction and no outbox. */
  it('dispatches a refresh with the token alone', async () => {
    await controller.refresh(
      { refreshToken: 'a.b.c', correlationId: 'c' },
      context,
    );

    expect(refresh.refresh).toHaveBeenCalledWith({
      refreshToken: 'a.b.c',
      correlationId: 'c',
    });
  });

  it.each([
    ['resendVerification', () => auth.resendVerification],
    ['resendLoginConfirmation', () => login.resendConfirmation],
  ])('%s dispatches a resend', async (method, mockFor) => {
    await (
      controller[method as 'resendVerification'] as (
        dto: object,
        context: RmqContext,
      ) => Promise<unknown>
    )({ challengeId: 'challenge-1', correlationId: 'c' }, context);

    expect(mockFor()).toHaveBeenCalled();
  });

  /** Every handler must be traceable, even one that arrived without an id. */
  it('generates a correlation id when the caller sent none', async () => {
    await controller.logIn({ email: 'a@b.c', password: 'x' }, context);

    const { correlationId } = login.login.mock.calls[0][0];

    expect(typeof correlationId).toBe('string');
    expect(correlationId.length).toBeGreaterThan(0);
  });

  describe('acking', () => {
    it('acks a business refusal', async () => {
      login.login.mockRejectedValue(
        new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'No', 401),
      );

      await expect(
        controller.logIn({ email: 'a@b.c', password: 'x' }, context),
      ).rejects.toThrow(AppError);
      expect(ack).toHaveBeenCalledWith(message);
    });

    it('leaves a crash for the broker to redeliver', async () => {
      login.login.mockRejectedValue(new Error('database gone'));

      await expect(
        controller.logIn({ email: 'a@b.c', password: 'x' }, context),
      ).rejects.toThrow('database gone');
      expect(ack).not.toHaveBeenCalled();
    });
  });
});
