import type { RmqContext } from '@nestjs/microservices';

import { AppError } from '../errors/app-error';

interface AckableChannel {
  ack: (message: unknown) => void;
}

/**
 * Runs a message handler and acks it manually.
 *
 * Consumers are configured with `noAck: false`, so the broker keeps a message
 * until it is acknowledged — a crash mid-handling redelivers rather than loses
 * it. That leaves the question of what to do with a *refusal*.
 *
 * A business refusal (a duplicate email, a wrong code, a 403) is a completed
 * handling: the reply carries the error code and the message is acked, because
 * a redelivery would be refused identically forever. Anything else is left
 * unacked, where a redelivery has a real chance of succeeding.
 */
export async function settleRpc<T>(
  context: RmqContext,
  handler: () => Promise<T>,
): Promise<T> {
  const channel = context.getChannelRef() as AckableChannel;
  const message = context.getMessage();

  try {
    const result = await handler();

    channel.ack(message);

    return result;
  } catch (error) {
    if (error instanceof AppError) {
      channel.ack(message);
    }

    throw error;
  }
}
