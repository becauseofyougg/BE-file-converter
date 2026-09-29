import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';
import { EmailRateLimitGuard } from './email-rate-limit.guard';

function contextWith(body: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ body, url: '/auth/register' }),
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('EmailRateLimitGuard', () => {
  let storage: jest.Mocked<ThrottlerStorage>;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  let guard: EmailRateLimitGuard;

  beforeEach(() => {
    storage = {
      increment: jest.fn().mockResolvedValue({
        totalHits: 1,
        timeToExpire: 3600,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    } as unknown as jest.Mocked<ThrottlerStorage>;

    reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue({ limit: 3, ttlMs: 3_600_000 }),
    };

    guard = new EmailRateLimitGuard(storage, reflector as unknown as Reflector);
  });

  it('allows a request below the limit', async () => {
    await expect(
      guard.canActivate(contextWith({ email: 'user@example.com' })),
    ).resolves.toBe(true);
  });

  it('refuses once the limit is exceeded', async () => {
    storage.increment.mockResolvedValue({
      totalHits: 4,
      timeToExpire: 1200,
      isBlocked: true,
      timeToBlockExpire: 1200,
    });

    await expect(
      guard.canActivate(contextWith({ email: 'user@example.com' })),
    ).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.RATE_LIMITED }),
    );
  });

  it('tells the caller when to come back', async () => {
    storage.increment.mockResolvedValue({
      totalHits: 4,
      timeToExpire: 1200,
      isBlocked: true,
      timeToBlockExpire: 1200,
    });

    expect.assertions(1);

    try {
      await guard.canActivate(contextWith({ email: 'user@example.com' }));
    } catch (error) {
      expect((error as AppError).details).toEqual({ retryAfterSeconds: 1200 });
    }
  });

  /**
   * Same account, different spelling — otherwise the limit is one free bucket
   * per capitalisation an attacker can think of.
   */
  it('counts case and whitespace variants as one address', async () => {
    await guard.canActivate(contextWith({ email: 'user@example.com' }));
    await guard.canActivate(contextWith({ email: '  USER@Example.COM ' }));

    const [firstKey] = storage.increment.mock.calls[0];
    const [secondKey] = storage.increment.mock.calls[1];

    expect(firstKey).toBe(secondKey);
  });

  it('does not put the address itself in the key', async () => {
    await guard.canActivate(contextWith({ email: 'user@example.com' }));

    expect(storage.increment.mock.calls[0][0]).not.toContain(
      'user@example.com',
    );
  });

  it('stands aside on routes that declare no limit', async () => {
    reflector.getAllAndOverride.mockReturnValue(
      undefined as unknown as { limit: number; ttlMs: number },
    );

    await expect(
      guard.canActivate(contextWith({ email: 'user@example.com' })),
    ).resolves.toBe(true);
    expect(storage.increment).not.toHaveBeenCalled();
  });

  it('stands aside when the body carries no email to key on', async () => {
    await expect(guard.canActivate(contextWith({}))).resolves.toBe(true);
    expect(storage.increment).not.toHaveBeenCalled();
  });
});

/**
 * Against the real storage, not a mock: the mock happily accepted the window
 * in seconds, and a 15-minute limit on login attempts then lasted 0.9 s —
 * which no brute force is slow enough to notice.
 */
describe('EmailRateLimitGuard with the real throttler storage', () => {
  let storage: ThrottlerStorageService;
  let guard: EmailRateLimitGuard;

  beforeEach(() => {
    storage = new ThrottlerStorageService();
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue({ limit: 5, ttlMs: 15 * 60 * 1000 }),
    } as unknown as Reflector;
    guard = new EmailRateLimitGuard(storage, reflector);
    jest.spyOn(guard['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => storage.onApplicationShutdown());

  it('refuses the sixth attempt on one address, for the whole 15 minutes', async () => {
    const attempt = () =>
      guard.canActivate(contextWith({ email: 'victim@example.com' }));

    for (let i = 0; i < 5; i += 1) {
      await expect(attempt()).resolves.toBe(true);
    }

    const error = (await attempt().catch((caught: unknown) => caught)) as {
      code: string;
      httpStatus: number;
      details: { retryAfterSeconds: number };
    };

    expect(error.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(error.httpStatus).toBe(429);
    expect(error.details.retryAfterSeconds).toBeGreaterThan(850);
  });

  it('counts each address separately', async () => {
    for (let i = 0; i < 5; i += 1) {
      await guard.canActivate(contextWith({ email: 'one@example.com' }));
    }

    await expect(
      guard.canActivate(contextWith({ email: 'two@example.com' })),
    ).resolves.toBe(true);
  });
});
