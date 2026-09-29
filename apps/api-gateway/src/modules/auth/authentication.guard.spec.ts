import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';
import { AuthenticationGuard } from './authentication.guard';
import type { Authenticator } from './authenticator';
import type { AuthenticatedRequest, RequestUser } from './request-user';

const ALICE: RequestUser = { id: 'alice', roles: ['USER'], tokenId: 't-1' };
const SCRIPT: RequestUser = {
  id: 'script',
  roles: ['SERVICE'],
  tokenId: 'k-1',
};

function httpContext(): {
  context: ExecutionContext;
  request: AuthenticatedRequest;
} {
  const request = { headers: {} } as AuthenticatedRequest;

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

const answering = (
  answer: RequestUser | null | Error,
): jest.Mocked<Authenticator> => ({
  authenticate: jest.fn<Promise<RequestUser | null>, [FastifyRequest]>(() =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
  ),
});

describe('AuthenticationGuard', () => {
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;

  const guardWith = (...authenticators: Authenticator[]) =>
    new AuthenticationGuard(authenticators, reflector as unknown as Reflector);

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
  });

  it('attaches the caller the first authenticator recognises', async () => {
    const { context, request } = httpContext();

    await expect(
      guardWith(answering(ALICE)).canActivate(context),
    ).resolves.toBe(true);
    expect(request.user).toBe(ALICE);
  });

  /** This is the extension point: a second scheme is one more list entry. */
  it('asks the next one when the first has nothing to say', async () => {
    const { context, request } = httpContext();
    const cookie = answering(null);
    const apiKey = answering(SCRIPT);

    await guardWith(cookie, apiKey).canActivate(context);

    expect(cookie.authenticate).toHaveBeenCalled();
    expect(request.user).toBe(SCRIPT);
  });

  it('stops at the first that recognises the request', async () => {
    const { context, request } = httpContext();
    const later = answering(SCRIPT);

    await guardWith(answering(ALICE), later).canActivate(context);

    expect(request.user).toBe(ALICE);
    expect(later.authenticate).not.toHaveBeenCalled();
  });

  /**
   * The property the ordering exists for: a forged credential of one kind is
   * not given a second chance under another.
   */
  it('fails, and asks no one else, when an authenticator refuses', async () => {
    const { context, request } = httpContext();
    const refusal = new AppError(ERROR_CODES.TOKEN_EXPIRED, 'Expired', 401);
    const later = answering(SCRIPT);

    await expect(
      guardWith(answering(refusal), later).canActivate(context),
    ).rejects.toBe(refusal);

    expect(later.authenticate).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('refuses a request nobody recognises', async () => {
    const { context } = httpContext();

    await expect(
      guardWith(answering(null), answering(null)).canActivate(context),
    ).rejects.toThrow(
      expect.objectContaining({
        code: ERROR_CODES.UNAUTHENTICATED,
        httpStatus: 401,
      }),
    );
  });

  /** Misconfiguration must lock the door, not open it. */
  it('fails closed with no authenticators at all', async () => {
    const { context } = httpContext();

    await expect(guardWith().canActivate(context)).rejects.toThrow(AppError);
  });

  it('lets a @Public() route through without asking anyone', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const { context, request } = httpContext();
    const authenticator = answering(ALICE);

    await expect(guardWith(authenticator).canActivate(context)).resolves.toBe(
      true,
    );
    expect(authenticator.authenticate).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  /** RPC and event handlers are authenticated by the broker connection. */
  it('stays out of the way of anything that is not HTTP', async () => {
    const authenticator = answering(null);
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;

    await expect(guardWith(authenticator).canActivate(context)).resolves.toBe(
      true,
    );
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });
});
