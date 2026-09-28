import type { RmqContext } from '@nestjs/microservices';

import {
  DOMAIN_EVENTS,
  type DomainEventEnvelope,
  type RbacUpdatedPayload,
} from '@contracts/events/domain.events';

import { RbacEventsController } from './rbac-events.controller';
import type { RbacConfigCache } from './rbac-config.cache';

describe('RbacEventsController', () => {
  let cache: jest.Mocked<RbacConfigCache>;
  let ack: jest.Mock;
  let context: RmqContext;
  let controller: RbacEventsController;

  const message = { fields: { deliveryTag: 1 } };

  const envelope = (
    payload?: Partial<RbacUpdatedPayload>,
  ): DomainEventEnvelope<RbacUpdatedPayload> =>
    ({
      eventId: 'event-1',
      eventName: DOMAIN_EVENTS.RBAC_UPDATED,
      occurredAt: new Date().toISOString(),
      correlationId: 'correlation-1',
      payload: {
        version: 'v2',
        entity: 'grant',
        operation: 'update',
        ...payload,
      },
    }) as DomainEventEnvelope<RbacUpdatedPayload>;

  beforeEach(() => {
    cache = {
      reload: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RbacConfigCache>;

    ack = jest.fn();
    context = {
      getChannelRef: () => ({ ack }),
      getMessage: () => message,
    } as unknown as RmqContext;

    controller = new RbacEventsController(cache);
    jest.spyOn(controller['logger'], 'log').mockImplementation(() => undefined);
  });

  it('reloads the cache, which is what applies a change without a restart', async () => {
    await controller.onRbacUpdated(envelope(), context);

    expect(cache.reload).toHaveBeenCalledWith('event', 'v2');
  });

  /**
   * The relay is at-least-once, so the same change arrives more than once; the
   * version lets the cache skip a reload it already did.
   */
  it('passes the announced version, so a redelivery is cheap', async () => {
    await controller.onRbacUpdated(envelope({ version: 'v7' }), context);

    expect(cache.reload).toHaveBeenCalledWith('event', 'v7');
  });

  it('acks the message', async () => {
    await controller.onRbacUpdated(envelope(), context);

    expect(ack).toHaveBeenCalledWith(message);
  });

  /**
   * Requeueing would spin against an identity that is down, and both the
   * boot-time load and the next change recover it.
   */
  it('acks even when the reload fails, rather than spinning', async () => {
    cache.reload.mockRejectedValue(new Error('identity down'));

    await expect(
      controller.onRbacUpdated(envelope(), context),
    ).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalledWith(message);
  });

  it('survives an envelope with no payload at all', async () => {
    await expect(
      controller.onRbacUpdated(
        { correlationId: 'c' } as DomainEventEnvelope<RbacUpdatedPayload>,
        context,
      ),
    ).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalled();
  });
});
