import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';

import {
  RBAC_PATTERNS,
  type RbacConfig,
} from '@contracts/messages/rbac.messages';
import { emptyRbacConfig } from '@core/rbac/rbac-policy';

import { RbacConfigCache } from './rbac-config.cache';

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
   * and the next `rbac.updated`, or a retry, fills it in.
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
});
