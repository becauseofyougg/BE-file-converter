import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';
import { JwtAuthGuard, type AuthenticatedRequest } from './jwt-auth.guard';

function contextFor(headers: Record<string, string> = {}): {
  context: ExecutionContext;
  request: AuthenticatedRequest;
} {
  const request = {
    headers,
    url: '/users/me',
  } as unknown as AuthenticatedRequest;

  return {
    request,
    context: {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext,
  };
}

describe('JwtAuthGuard', () => {
  let jwt: jest.Mocked<Pick<JwtService, 'verifyAsync'>>;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        roles: ['USER'],
        jti: 'jti-1',
      }),
    };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };

    guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
      reflector as unknown as Reflector,
    );
  });

  it('attaches the caller from a valid token', async () => {
    const { context, request } = contextFor({ authorization: 'Bearer good' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 'user-1',
      roles: ['USER'],
      tokenId: 'jti-1',
    });
  });

  it('accepts the scheme case-insensitively', async () => {
    const { context } = contextFor({ authorization: 'bearer good' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('refuses a request with no Authorization header', async () => {
    const { context } = contextFor();

    await expect(guard.canActivate(context)).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNAUTHENTICATED }),
    );
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('refuses a header that is not a bearer token', async () => {
    const { context } = contextFor({ authorization: 'Basic abc' });

    await expect(guard.canActivate(context)).rejects.toThrow(AppError);
  });

  it('refuses a token that fails verification', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('bad signature'));
    const { context } = contextFor({ authorization: 'Bearer forged' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNAUTHENTICATED }),
    );
  });

  /** A client should refresh, not send the user back to a login form. */
  it('distinguishes an expired token from an invalid one', async () => {
    const expired = new Error('jwt expired');
    expired.name = 'TokenExpiredError';
    jwt.verifyAsync.mockRejectedValue(expired);

    const { context } = contextFor({ authorization: 'Bearer stale' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.TOKEN_EXPIRED }),
    );
  });

  it('lets a @Public() route through without a token', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const { context } = contextFor();

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  /**
   * A token with no `roles` claim would otherwise yield `undefined`, and the
   * evaluator would crash rather than deny. It must become "no roles".
   */
  it('treats a token with no roles claim as holding none', async () => {
    jwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1' });
    const { context, request } = contextFor({ authorization: 'Bearer odd' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user?.roles).toEqual([]);
  });
});
