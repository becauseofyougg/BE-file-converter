import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';

import {
  RBAC_PATTERNS,
  type RbacConfig,
} from '@contracts/messages/rbac.messages';
import { emptyRbacConfig } from '@core/rbac/rbac-policy';

import {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RbacConfigCache,
} from './rbac-config.cache';

function buildConfig(version = 'v1'): RbacConfig {
  return {
    version,
    generatedAt: new Date().toISOString(),
    permissions: [{ name: 'users', actions: ['read'] }],
    roles: [{ name: 'ADMIN', grants: [{ permission: 'users', actions: [] }] }],
  };
}

describe('RbacConfigCache', () => {
  let send: jest.Mock;
  let cache: RbacConfigCache;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of(buildConfig()));
    cache = new RbacConfigCache({ send } as unknown as ClientProxy);
    jest.spyOn(cache['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(cache['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(cache['logger'], 'warn').mockImplementation(() => undefined);
  });

  // A failed fetch leaves a retry pending; it must not outlive its test.
  afterEach(() => {
    cache.onModuleDestroy();
  });

  /**
   * An empty config denies everything. A gateway that came up without rules
   * would otherwise have to choose between allowing everything and pretending.
   */
  it('starts empty, which denies everything', () => {
    expect(cache.current().version).toBe(emptyRbacConfig().version);
    expect(cache.isLoaded()).toBe(false);
  });

  it('loads the config at boot', async () => {
    await cache.onModuleInit();

    expect(send).toHaveBeenCalledWith(RBAC_PATTERNS.GET_CONFIG, {});
    expect(cache.current().version).toBe('v1');
    expect(cache.isLoaded()).toBe(true);
  });

  /**
   * Identity may simply be slower to start. The config stays empty — denying —
   * until the retry fills it in.
   */
  it('boots anyway when identity is not up yet', async () => {
    send.mockReturnValue(throwError(() => new Error('no route to host')));

    await expect(cache.onModuleInit()).resolves.toBeUndefined();
    expect(cache.isLoaded()).toBe(false);
  });

  /**
   * Stale rules are better than none, and none would lock every user out
   * because the evaluator fails closed.
   */
  it('keeps the previous config when a reload fails', async () => {
    await cache.reload('boot');
    send.mockReturnValue(throwError(() => new Error('broker down')));

    await expect(cache.reload('event')).rejects.toThrow('broker down');
    expect(cache.current().version).toBe('v1');
  });

  it('skips the round trip when it already holds the announced version', async () => {
    await cache.reload('boot');
    send.mockClear();

    await cache.reload('event', 'v1');

    expect(send).not.toHaveBeenCalled();
  });

  it('fetches when the announced version is a different one', async () => {
    await cache.reload('boot');
    send.mockReturnValue(of(buildConfig('v2')));

    await cache.reload('event', 'v2');

    expect(cache.current().version).toBe('v2');
  });

  /**
   * Several `rbac.updated` messages arriving together should not mean several
   * round trips for the same answer.
   */
  it('collapses concurrent reloads into one fetch', async () => {
    let release: (config: RbacConfig) => void = () => undefined;
    send.mockReturnValue({
      pipe: () => ({
        subscribe: (observer: {
          next: (v: RbacConfig) => void;
          complete: () => void;
        }) => {
          release = (config) => {
            observer.next(config);
            observer.complete();
          };

          return { unsubscribe: () => undefined };
        },
      }),
    });

    const first = cache.reload('a');
    const second = cache.reload('b');

    release(buildConfig('v9'));
    await Promise.all([first, second]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('allows a later reload after one is finished', async () => {
    await cache.reload('first');
    await cache.reload('second');

    expect(send).toHaveBeenCalledTimes(2);
  });

  /**
   * An empty config denies `rbac@manage` too, so the admin change that would
   * announce `rbac.updated` is itself refused. Without a retry, a gateway that
   * booted before identity stayed locked out until restarted.
   */
  describe('retrying', () => {
    const failing = () => throwError(() => new Error('no route to host'));

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('keeps trying after a failed boot until identity answers', async () => {
      send.mockReturnValueOnce(failing()).mockReturnValueOnce(failing());

      await cache.onModuleInit();
      expect(cache.isLoaded()).toBe(false);

      await jest.advanceTimersByTimeAsync(RETRY_BASE_MS);
      expect(cache.isLoaded()).toBe(false);

      await jest.advanceTimersByTimeAsync(RETRY_BASE_MS * 2);
      expect(cache.isLoaded()).toBe(true);
      expect(send).toHaveBeenCalledTimes(3);
    });

    it('backs off, doubling up to a ceiling', async () => {
      send.mockImplementation(failing);
      const warn = jest.spyOn(cache['logger'], 'warn');

      await cache.onModuleInit();

      for (let i = 0; i < 8; i += 1) {
        await jest.advanceTimersByTimeAsync(RETRY_MAX_MS);
      }

      const delays = warn.mock.calls.map(
        ([entry]) => (entry as { delayMs: number }).delayMs,
      );

      expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
      expect(Math.max(...delays)).toBe(RETRY_MAX_MS);
    });

    it('recovers from a failed reload instead of serving stale rules', async () => {
      await cache.reload('boot');
      send
        .mockReturnValueOnce(failing())
        .mockReturnValueOnce(of(buildConfig('v2')));

      await expect(cache.reload('event', 'v2')).rejects.toThrow();
      expect(cache.current().version).toBe('v1');

      await jest.advanceTimersByTimeAsync(RETRY_BASE_MS);
      expect(cache.current().version).toBe('v2');
    });

    it('starts the backoff over once a fetch succeeds', async () => {
      send
        .mockReturnValueOnce(failing())
        .mockReturnValueOnce(failing())
        .mockReturnValueOnce(of(buildConfig('v1')))
        .mockReturnValueOnce(failing());
      const warn = jest.spyOn(cache['logger'], 'warn');

      await cache.onModuleInit();
      await jest.advanceTimersByTimeAsync(RETRY_BASE_MS * 3);
      expect(cache.isLoaded()).toBe(true);

      await expect(cache.reload('event', 'v2')).rejects.toThrow();

      expect(warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ delayMs: RETRY_BASE_MS }),
      );
    });

    it('drops the pending retry when another trigger succeeds first', async () => {
      send.mockReturnValueOnce(failing());

      await cache.onModuleInit();
      await cache.reload('event');
      await jest.advanceTimersByTimeAsync(RETRY_MAX_MS);

      expect(send).toHaveBeenCalledTimes(2);
    });

    it('stops retrying on shutdown', async () => {
      send.mockImplementation(failing);

      await cache.onModuleInit();
      cache.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(RETRY_MAX_MS);

      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
