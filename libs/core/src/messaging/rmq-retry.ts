import type { RmqContext } from '@nestjs/microservices';
import type { Channel, ConsumeMessage, Options } from 'amqplib';

import { RETRY_COUNT_HEADER } from '@contracts/messaging/topology';

/**
 * A retry ladder: one TTL queue per step, each dead-lettering back to the
 * queue the consumer reads. A message parked on step N waits out that queue's
 * TTL, then reappears on the work queue as if it had just arrived.
 *
 * The consumer never sleeps. That matters with `prefetchCount: 1` — a handler
 * waiting ten minutes on one recipient would hold up every message behind it.
 */
export interface RetryLadder {
  /** The work queue the retry queues dead-letter back into. */
  target: string;
  /** The queue for step `n`, 1-based. */
  queue: (step: number) => string;
  /** One delay per step; the ladder is exhausted after the last. */
  delaysMs: readonly number[];
  /** Where a message goes once the ladder runs out. */
  deadLetterQueue: string;
}

export type RetryResult = 'scheduled' | 'exhausted';

/**
 * Nest hands the handler the raw amqplib channel, which amqp-connection-manager
 * opens in confirm mode — so `waitForConfirms` is there in practice, but the
 * type does not say so.
 */
type ConsumerChannel = Channel & { waitForConfirms?: () => Promise<void> };

/**
 * Queues already declared on a channel. Declaring is idempotent but costs a
 * round trip, and a reconnect opens a new channel — which is exactly when the
 * declarations need repeating.
 */
const declared = new WeakMap<Channel, Set<string>>();

/**
 * How many times this message has already been through the ladder. Asks for
 * the headers alone, so a caller need not build a whole AMQP message to ask.
 */
export function retryCount(message: {
  properties?: { headers?: Record<string, unknown> };
}): number {
  const value: unknown = message.properties?.headers?.[RETRY_COUNT_HEADER];
  const count = typeof value === 'number' ? value : Number(value);

  return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * Parks the message on the next step of the ladder and acks the original, or —
 * if the ladder is spent — moves it to the dead-letter queue and acks it.
 *
 * The copy is confirmed by the broker **before** the original is acked, so a
 * crash in between duplicates the message rather than losing it. Consumers are
 * idempotent; they are not clairvoyant.
 */
export async function scheduleRetry(
  context: RmqContext,
  ladder: RetryLadder,
): Promise<RetryResult> {
  const channel = context.getChannelRef() as ConsumerChannel;
  const message = context.getMessage() as ConsumeMessage;
  const step = retryCount(message) + 1;

  if (step > ladder.delaysMs.length) {
    await deadLetter(context, ladder);

    return 'exhausted';
  }

  const queue = ladder.queue(step);

  await declare(channel, queue, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-message-ttl': ladder.delaysMs[step - 1],
      // The default exchange routes by queue name, so this lands on the work
      // queue itself rather than being fanned out to every subscriber again.
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': ladder.target,
    },
  });

  await republish(channel, queue, message, step);

  return 'scheduled';
}

/**
 * Moves the message to the ladder's dead-letter queue and acks the original:
 * kept for an operator to inspect or replay, and out of the way of everything
 * else.
 */
export async function deadLetter(
  context: RmqContext,
  ladder: Pick<RetryLadder, 'deadLetterQueue'>,
): Promise<void> {
  const channel = context.getChannelRef() as ConsumerChannel;
  const message = context.getMessage() as ConsumeMessage;

  await declare(channel, ladder.deadLetterQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });

  await republish(
    channel,
    ladder.deadLetterQueue,
    message,
    retryCount(message),
  );
}

async function declare(
  channel: ConsumerChannel,
  queue: string,
  options: Options.AssertQueue,
): Promise<void> {
  const known = declared.get(channel) ?? new Set<string>();

  if (known.has(queue)) {
    return;
  }

  await channel.assertQueue(queue, options);
  known.add(queue);
  declared.set(channel, known);
}

async function republish(
  channel: ConsumerChannel,
  queue: string,
  message: ConsumeMessage,
  retries: number,
): Promise<void> {
  const { properties } = message;

  // The body is copied byte for byte: Nest dispatches on the pattern inside it,
  // not on the routing key, so the handler that sees it again is the same one.
  channel.sendToQueue(queue, message.content, {
    persistent: true,
    contentType: properties.contentType as string | undefined,
    contentEncoding: properties.contentEncoding as string | undefined,
    correlationId: properties.correlationId as string | undefined,
    messageId: properties.messageId as string | undefined,
    headers: { ...properties.headers, [RETRY_COUNT_HEADER]: retries },
  });

  await channel.waitForConfirms?.();

  channel.ack(message);
}
