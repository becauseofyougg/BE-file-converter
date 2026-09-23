import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ThrottlerStorage } from '@nestjs/throttler';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { ProfileReadRateLimitGuard } from './profile-read-rate-limit.guard';

const VIEWER = 'viewer-1';
const TARGET = 'target-1';

function buildContext(
  params: Record<string, string>,
  user?: { id: string; roles: string[] },
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params, user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('ProfileReadRateLimitGuard', () => {
  let storage: jest.Mocked<ThrottlerStorage>;
  let reflector: Reflector;
  let guard: ProfileReadRateLimitGuard;

  beforeEach(() => {
    storage = {
      increment: jest
        .fn()
        .mockResolvedValue({ totalHits: 1, timeToExpire: 3600 }),
    } as unknown as jest.Mocked<ThrottlerStorage>;

    reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue({ limit: 60, ttlMs: 3_600_000 });

    guard = new ProfileReadRateLimitGuard(storage, reflector);
  });

  it('counts a read of someone else, keyed on the viewer', async () => {
    await expect(
      guard.canActivate(
        buildContext({ userId: TARGET }, { id: VIEWER, roles: ['SUPPORT'] }),
      ),
    ).resolves.toBe(true);

    expect(storage.increment).toHaveBeenCalledWith(
      `profile-read:${VIEWER}`,
      3600,
      60,
      0,
      'profile-read',
    );
  });

  /**
   * Polling your own profile is ordinary, reveals nothing about anyone else,
   * and counting it would let a busy tab lock its own user out.
   */
  it('does not count a self-read', async () => {
    await expect(
      guard.canActivate(
        buildContext({ userId: VIEWER }, { id: VIEWER, roles: ['USER'] }),
      ),
    ).resolves.toBe(true);

    expect(storage.increment).not.toHaveBeenCalled();
  });

  it('refuses once the viewer is over the limit', async () => {
    storage.increment.mockResolvedValue({
      totalHits: 61,
      timeToExpire: 1200,
      isBlocked: false,
      timeToBlockExpire: 0,
    });

    await expect(
      guard.canActivate(
        buildContext({ userId: TARGET }, { id: VIEWER, roles: ['SUPPORT'] }),
      ),
    ).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.RATE_LIMITED }),
    );
  });

  it('stays out of the way when the route declares no limit', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    await expect(
      guard.canActivate(
        buildContext({ userId: TARGET }, { id: VIEWER, roles: ['SUPPORT'] }),
      ),
    ).resolves.toBe(true);

    expect(storage.increment).not.toHaveBeenCalled();
  });

  it('passes an unauthenticated request on to the guard that handles it', async () => {
    await expect(
      guard.canActivate(buildContext({ userId: TARGET })),
    ).resolves.toBe(true);

    expect(storage.increment).not.toHaveBeenCalled();
  });
});
