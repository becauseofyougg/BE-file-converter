import type { ClientProxy } from '@nestjs/microservices';

import type { HealthProbe } from './health.probes';

/**
 * Is the broker reachable?
 *
 * Asked through a `ClientProxy` the service already holds rather than by
 * opening a connection of its own. `connect()` resolves immediately when the
 * channel is up and rejects when it is not, so the probe measures the
 * connection the application would actually use — a separate one could be
 * healthy while the real channel is wedged, which is the failure worth
 * catching.
 */
export function brokerProbe(
  client: ClientProxy,
  name = 'rabbitmq',
): HealthProbe {
  return {
    name,
    check: () => client.connect(),
  };
}

/**
 * Is object storage reachable and the bucket usable?
 *
 * Structural rather than importing `StorageService`: `libs/core` has no
 * business depending on the storage library, and everything this needs is one
 * method.
 */
export function storageProbe(storage: {
  ping(): Promise<unknown>;
}): HealthProbe {
  return {
    name: 'storage',
    check: () => storage.ping(),
  };
}
