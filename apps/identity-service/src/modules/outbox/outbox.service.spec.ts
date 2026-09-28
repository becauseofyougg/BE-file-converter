import { TransactionHost } from '@nestjs-cls/transactional';

import { DOMAIN_EVENTS } from '@contracts/events/domain.events';

import { OutboxService } from './outbox.service';

describe('OutboxService', () => {
  let create: jest.Mock;
  let service: OutboxService;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue(undefined);

    service = new OutboxService({
      tx: { outboxMessage: { create } },
    } as unknown as TransactionHost<never>);
  });

  const written = () => create.mock.calls[0][0].data as Record<string, unknown>;

  describe('publish', () => {
    it('writes the event, its payload and the correlation id', async () => {
      await service.publish(
        DOMAIN_EVENTS.USER_REGISTERED,
        { userId: 'user-1', email: 'a@b.c' },
        'correlation-1',
      );

      expect(written()).toMatchObject({
        eventName: DOMAIN_EVENTS.USER_REGISTERED,
        payload: { userId: 'user-1', email: 'a@b.c' },
        correlationId: 'correlation-1',
      });
    });

    /**
     * Unpublished and un-attempted is what makes the row claimable. A default
     * on the column would do it too, but the relay's `WHERE published_at IS
     * NULL AND attempts < 10` is the contract, and writing both explicitly is
     * what keeps this readable next to it.
     */
    it('leaves the row for the relay to claim', async () => {
      await service.publish(DOMAIN_EVENTS.USER_DELETED, {}, 'c');

      expect(written()).toMatchObject({ publishedAt: null, attempts: 0 });
    });

    /**
     * Through `txHost.tx`, so the event and the state change it describes
     * commit or roll back together — the whole reason the outbox exists.
     */
    it('writes through the ambient transaction', async () => {
      await service.publish(DOMAIN_EVENTS.USER_EMAIL_VERIFIED, {}, 'c');

      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  describe('envelope', () => {
    it('builds the shape a consumer receives', () => {
      const occurredAt = new Date('2026-01-01T00:00:00.000Z');

      expect(
        OutboxService.envelope(
          {
            id: 'event-1',
            eventName: DOMAIN_EVENTS.USER_REGISTERED,
            occurredAt,
            correlationId: 'correlation-1',
          },
          { userId: 'user-1' },
        ),
      ).toEqual({
        eventId: 'event-1',
        eventName: DOMAIN_EVENTS.USER_REGISTERED,
        occurredAt: '2026-01-01T00:00:00.000Z',
        correlationId: 'correlation-1',
        payload: { userId: 'user-1' },
      });
    });

    /** A consumer parsing a date needs one format, not two. */
    it('serialises the timestamp, rather than passing a Date', () => {
      const envelope = OutboxService.envelope(
        {
          id: 'e',
          eventName: DOMAIN_EVENTS.USER_DELETED,
          occurredAt: new Date(),
          correlationId: 'c',
        },
        {},
      );

      expect(typeof envelope.occurredAt).toBe('string');
    });
  });
});
