import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';

import {
  DOMAIN_EVENTS,
  type DomainEventEnvelope,
  type RbacUpdatedPayload,
} from '@contracts/events/domain.events';
import { RbacConfigCache } from './rbac-config.cache';

/**
 * Listens for `rbac.updated` and refreshes the cache — this is what makes a
 * rule change take effect without a restart (docs/RBAC.md §1.2 scenario 2).
 *
 * The event carries the new version but not the config itself: the payload
 * would otherwise grow with the ruleset, and every replica would have to trust
 * a broker message to decide who may do what. It is a signal to go and read,
 * not the thing read.
 */
@Controller()
export class RbacEventsController {
  private readonly logger = new Logger(RbacEventsController.name);

  constructor(private readonly cache: RbacConfigCache) {}

  @EventPattern(DOMAIN_EVENTS.RBAC_UPDATED)
  async onRbacUpdated(
    @Payload() envelope: DomainEventEnvelope<RbacUpdatedPayload>,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef() as { ack: (m: unknown) => void };
    const message = context.getMessage();

    try {
      this.logger.log({
        event: 'rbac.update_received',
        version: envelope.payload?.version,
        entity: envelope.payload?.entity,
        operation: envelope.payload?.operation,
        correlationId: envelope.correlationId,
      });

      // The version short-circuits a redelivery of something already applied;
      // the relay is at-least-once, so the same change arrives more than once.
      await this.cache.reload('event', envelope.payload?.version);
    } catch {
      // Swallowed on purpose. A failed reload leaves the previous config in
      // place and is already logged as an error by the cache; requeueing would
      // spin against an identity that is down, and the boot-time load plus the
      // next change both recover it.
    } finally {
      channel.ack(message);
    }
  }
}
