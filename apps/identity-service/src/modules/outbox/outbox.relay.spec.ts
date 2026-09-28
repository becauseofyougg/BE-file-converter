import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';

import { DOMAIN_EVENTS } from '@contracts/events/domain.events';

import type { PrismaService } from '../../database/prisma.service';
import { OutboxRelay } from './outbox.relay';

interface Claimed {
  id: string;
  eventName: string;
  payload: unknown;
  correlationId: string;
  occurredAt: Date;
  attempts: number;
}

function buildMessage(overrides: Partial<Claimed> = {}): Claimed {
  return {
    id: 'event-1',
    eventName: DOMAIN_EVENTS.USER_REGISTERED,
    payload: { userId: 'user-1' },
    correlationId: 'correlation-1',
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    attempts: 0,
    ...overrides,
  };
}

describe('OutboxRelay', () => {
  let queryRaw: jest.Mock;
  let update: jest.Mock;
  let emit: jest.Mock;
  let relay: OutboxRelay;

  /** Each call to `$transaction` gets the next queued batch. */
  function queueBatches(...batches: Claimed[][]): void {
    let call = 0;
    queryRaw.mockImplementation(() => Promise.resolve(batches[call++] ?? []));
  }

  beforeEach(() => {
    queryRaw = jest.fn().mockResolvedValue([]);
    update = jest.fn().mockResolvedValue(undefined);
    emit = jest.fn().mockReturnValue(of(undefined));

    const prisma = {
      $transaction: (work: (tx: unknown) => unknown) =>
        work({ $queryRaw: queryRaw }),
      outboxMessage: { update },
    } as unknown as PrismaService;

    relay = new OutboxRelay(prisma, { emit } as unknown as ClientProxy);
    jest.spyOn(relay['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(relay['logger'], 'warn').mockImplementation(() => undefined);
  });

  it('does nothing when the outbox is empty', async () => {
    await relay.drain();

    expect(emit).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('emits each claimed message under its own event name', async () => {
    queueBatches([buildMessage()]);

    await relay.drain();

    expect(emit).toHaveBeenCalledWith(
      DOMAIN_EVENTS.USER_REGISTERED,
      expect.objectContaining({
        eventId: 'event-1',
        correlationId: 'correlation-1',
        payload: { userId: 'user-1' },
      }),
    );
  });

  it('marks a published row so it is not claimed again', async () => {
    queueBatches([buildMessage()]);

    await relay.drain();

    expect(update).toHaveBeenCalledWith({
      where: { id: 'event-1' },
      data: { publishedAt: expect.any(Date) },
    });
  });

  /**
   * Left unpublished, so the next tick retries it. Marking it published on a
   * failed emit would silently lose the event — the failure mode the outbox
   * exists to prevent.
   */
  it('counts an attempt and keeps the row when the broker refuses', async () => {
    queueBatches([buildMessage()]);
    emit.mockReturnValue(throwError(() => new Error('broker down')));

    await relay.drain();

    expect(update).toHaveBeenCalledWith({
      where: { id: 'event-1' },
      data: { attempts: { increment: 1 }, lastError: 'broker down' },
    });
  });

  it('keeps going after one message fails', async () => {
    queueBatches([buildMessage({ id: 'a' }), buildMessage({ id: 'b' })]);
    emit
      .mockReturnValueOnce(throwError(() => new Error('transient')))
      .mockReturnValue(of(undefined));

    await relay.drain();

    expect(emit).toHaveBeenCalledTimes(2);
  });

  /**
   * A backlog should clear at the relay's pace rather than 50 rows per tick,
   * so a full batch means "ask again immediately".
   */
  it('keeps claiming while batches come back full', async () => {
    const full = Array.from({ length: 50 }, (_unused, index) =>
      buildMessage({ id: `event-${index}` }),
    );
    queueBatches(full, [buildMessage({ id: 'last' })]);

    await relay.drain();

    expect(emit).toHaveBeenCalledTimes(51);
  });

  it('stops after a partial batch', async () => {
    queueBatches([buildMessage()], [buildMessage({ id: 'never-reached' })]);

    await relay.drain();

    expect(emit).toHaveBeenCalledTimes(1);
  });

  /**
   * A slow broker must not let ticks pile up on top of each other — the second
   * one would claim rows the first is still publishing.
   */
  it('refuses to run twice at once', async () => {
    let release: () => void = () => undefined;
    queryRaw.mockImplementation(
      () =>
        new Promise<Claimed[]>((resolve) => {
          release = () => resolve([]);
        }),
    );

    const first = relay.drain();
    await Promise.resolve();
    await relay.drain();

    release();
    await first;

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('clears the guard even when a tick throws', async () => {
    queryRaw.mockRejectedValueOnce(new Error('database gone'));

    await expect(relay.drain()).rejects.toThrow('database gone');

    queryRaw.mockResolvedValue([]);
    await expect(relay.drain()).resolves.toBeUndefined();
  });
});
