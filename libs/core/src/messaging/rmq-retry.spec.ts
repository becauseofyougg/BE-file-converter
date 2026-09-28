import type { RmqContext } from '@nestjs/microservices';

import { RETRY_COUNT_HEADER } from '@contracts/messaging/topology';

import {
  deadLetter,
  type RetryLadder,
  retryCount,
  scheduleRetry,
} from './rmq-retry';

const LADDER: RetryLadder = {
  target: 'work',
  queue: (step) => `work.retry.${step}`,
  delaysMs: [1_000, 5_000],
  deadLetterQueue: 'work.dlq',
};

describe('rmq retry ladder', () => {
  let channel: {
    assertQueue: jest.Mock;
    sendToQueue: jest.Mock;
    waitForConfirms: jest.Mock;
    ack: jest.Mock;
  };
  let order: string[];

  const message = (headers: Record<string, unknown> = {}) => ({
    content: Buffer.from('{"pattern":"user.registered","data":{}}'),
    properties: {
      contentType: 'application/json',
      correlationId: 'correlation-1',
      messageId: 'message-1',
      headers,
    },
    fields: { deliveryTag: 1 },
  });

  const contextFor = (msg: ReturnType<typeof message>) =>
    ({
      getChannelRef: () => channel,
      getMessage: () => msg,
    }) as unknown as RmqContext;

  beforeEach(() => {
    order = [];
    // A fresh channel per test: the declaration cache is keyed on it.
    channel = {
      assertQueue: jest.fn().mockResolvedValue({}),
      sendToQueue: jest.fn(() => order.push('send')),
      waitForConfirms: jest.fn(() => {
        order.push('confirm');
        return Promise.resolve();
      }),
      ack: jest.fn(() => order.push('ack')),
    };
  });

  describe('retryCount', () => {
    it.each([
      [{}, 0],
      [{ [RETRY_COUNT_HEADER]: 2 }, 2],
      // AMQP headers written by another client may arrive as strings.
      [{ [RETRY_COUNT_HEADER]: '3' }, 3],
      [{ [RETRY_COUNT_HEADER]: 'nonsense' }, 0],
      [{ [RETRY_COUNT_HEADER]: -1 }, 0],
    ])('reads %j as %d', (headers, expected) => {
      expect(retryCount(message(headers))).toBe(expected);
    });

    it('treats a message with no headers at all as never retried', () => {
      expect(retryCount({ properties: {} } as never)).toBe(0);
    });
  });

  describe('scheduleRetry', () => {
    it('parks a first failure on step one, which dead-letters back to the work queue', async () => {
      const msg = message();

      await expect(scheduleRetry(contextFor(msg), LADDER)).resolves.toBe(
        'scheduled',
      );

      expect(channel.assertQueue).toHaveBeenCalledWith('work.retry.1', {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-message-ttl': 1_000,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': 'work',
        },
      });
      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'work.retry.1',
        msg.content,
        expect.objectContaining({
          persistent: true,
          correlationId: 'correlation-1',
          headers: { [RETRY_COUNT_HEADER]: 1 },
        }),
      );
    });

    it('moves up a step, and keeps the headers it did not write', async () => {
      await scheduleRetry(
        contextFor(message({ [RETRY_COUNT_HEADER]: 1, 'x-other': 'kept' })),
        LADDER,
      );

      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'work.retry.2',
        expect.anything(),
        expect.objectContaining({
          headers: { [RETRY_COUNT_HEADER]: 2, 'x-other': 'kept' },
        }),
      );
    });

    /**
     * The whole point of confirming first: a crash between the two then
     * duplicates the message instead of losing it.
     */
    it('acks the original only once the copy is confirmed', async () => {
      await scheduleRetry(contextFor(message()), LADDER);

      expect(order).toEqual(['send', 'confirm', 'ack']);
    });

    it('dead-letters once the ladder is spent', async () => {
      const msg = message({ [RETRY_COUNT_HEADER]: 2 });

      await expect(scheduleRetry(contextFor(msg), LADDER)).resolves.toBe(
        'exhausted',
      );

      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'work.dlq',
        msg.content,
        expect.objectContaining({ headers: { [RETRY_COUNT_HEADER]: 2 } }),
      );
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    it('declares each queue once per channel', async () => {
      await scheduleRetry(contextFor(message()), LADDER);
      await scheduleRetry(contextFor(message()), LADDER);

      expect(channel.assertQueue).toHaveBeenCalledTimes(1);
    });

    it('does not ack when the broker refuses the copy', async () => {
      channel.waitForConfirms.mockRejectedValue(new Error('nacked'));

      await expect(
        scheduleRetry(contextFor(message()), LADDER),
      ).rejects.toThrow('nacked');

      expect(channel.ack).not.toHaveBeenCalled();
    });

    it('still works on a channel without publisher confirms', async () => {
      delete (channel as Partial<typeof channel>).waitForConfirms;

      await scheduleRetry(contextFor(message()), LADDER);

      expect(channel.ack).toHaveBeenCalled();
    });
  });

  describe('deadLetter', () => {
    it('declares the dead-letter queue and moves the message there', async () => {
      const msg = message();

      await deadLetter(contextFor(msg), LADDER);

      expect(channel.assertQueue).toHaveBeenCalledWith('work.dlq', {
        durable: true,
        arguments: { 'x-queue-type': 'quorum' },
      });
      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'work.dlq',
        msg.content,
        expect.anything(),
      );
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });
  });
});
