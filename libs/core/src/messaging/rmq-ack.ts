import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { RmqContext } from '@nestjs/microservices';
import { finalize, type Observable } from 'rxjs';

interface AckableChannel {
  ack: (message: unknown) => void;
}

/**
 * Messages already acknowledged. Acking one twice is not harmless: RabbitMQ
 * answers an unknown delivery tag by closing the channel, which drops every
 * other message in flight on it.
 */
const acked = new WeakSet<object>();

/** Acks the message behind `context`, once, however many callers ask. */
export function ackOnce(context: RmqContext): void {
  const message = context.getMessage() as object;

  if (acked.has(message)) {
    return;
  }

  acked.add(message);
  (context.getChannelRef() as AckableChannel).ack(message);
}

/**
 * Runs a request/response handler and acks its message — **whatever happens**.
 *
 * Consumers run with `noAck: false`, and an unacked message is not redelivered
 * while its channel lives: it sits in the consumer's only prefetch slot and
 * the consumer takes nothing else. So "leave it unacked and it will be
 * retried" was never true. It stopped identity answering anyone, until a
 * restart redelivered the same message and stopped it again.
 *
 * For RPC, acking a failure loses nothing. The caller is waiting on a reply
 * with a timeout; it gets the error (a business refusal with its code,
 * anything else as `INTERNAL_ERROR`) and decides for itself whether to try
 * again. A redelivery minutes later would answer a question nobody is still
 * asking.
 */
export async function settleRpc<T>(
  context: RmqContext,
  handler: () => Promise<T>,
): Promise<T> {
  try {
    return await handler();
  } finally {
    ackOnce(context);
  }
}

/**
 * The same guarantee for what fails **before** the handler runs — a
 * `ValidationPipe` refusing the payload. Pipes run inside the interceptor
 * chain, so their failure reaches `finalize`; it never reaches `settleRpc`,
 * and was the way in: one message with an over-long header field wedged
 * identity for everyone. (Guards run before interceptors and are not covered;
 * the RPC handlers have none.)
 *
 * Registered globally on a request/response service; `ackOnce` makes it safe
 * alongside `settleRpc`, which usually gets there first. Event consumers
 * settle their messages themselves (ack, retry ladder, dead letter) and must
 * not have this.
 */
@Injectable()
export class RmqAckInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') {
      return next.handle();
    }

    const rmq = context.switchToRpc().getContext<RmqContext>();

    return next.handle().pipe(finalize(() => ackOnce(rmq)));
  }
}
