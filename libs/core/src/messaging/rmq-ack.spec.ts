import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import type { RmqContext } from '@nestjs/microservices';
import { lastValueFrom, of, throwError } from 'rxjs';

import { ERROR_CODES } from '@contracts/errors/error-codes';

import { AppError } from '../errors/app-error';
import { ackOnce, RmqAckInterceptor, settleRpc } from './rmq-ack';

describe('settleRpc', () => {
  let ack: jest.Mock;
  let context: RmqContext;
  // A fresh object per test, as each delivery is: acks are tracked per message.
  let message: { fields: { deliveryTag: number } };

  beforeEach(() => {
    message = { fields: { deliveryTag: 1 } };
    ack = jest.fn();
    context = {
      getChannelRef: () => ({ ack }),
      getMessage: () => message,
    } as unknown as RmqContext;
  });

  it('acks a handled message and returns its result', async () => {
    await expect(settleRpc(context, () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );

    expect(ack).toHaveBeenCalledWith(message);
  });

  /**
   * A duplicate email or a wrong code is a *completed* handling: the reply
   * carries the error code, and redelivering it would fail identically
   * forever.
   */
  it('acks a business refusal, because retrying it is pointless', async () => {
    const refusal = new AppError(
      ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      'Taken',
      409,
    );

    await expect(
      settleRpc(context, () => Promise.reject(refusal)),
    ).rejects.toBe(refusal);

    expect(ack).toHaveBeenCalledWith(message);
  });

  /**
   * This used to be left unacked "so the broker redelivers it". It does not:
   * an unacked message stays in the consumer's only prefetch slot for as long
   * as the channel lives, and the consumer takes nothing else. Identity
   * stopped answering anyone. The caller has the error and its own timeout;
   * the message is done with.
   */
  it('acks an unexpected failure too, so one bad message cannot wedge the consumer', async () => {
    const crash = new Error('connection lost');

    await expect(settleRpc(context, () => Promise.reject(crash))).rejects.toBe(
      crash,
    );

    expect(ack).toHaveBeenCalledWith(message);
  });

  it('rethrows rather than swallowing, so the reply still carries the failure', async () => {
    await expect(
      settleRpc(context, () =>
        Promise.reject(new AppError(ERROR_CODES.FORBIDDEN, 'No', 403)),
      ),
    ).rejects.toThrow(AppError);
  });
});

describe('ackOnce', () => {
  /** RabbitMQ answers a second ack of one tag by closing the whole channel. */
  it('acks a message once, however many times it is asked', () => {
    const ack = jest.fn();
    const message = { fields: { deliveryTag: 7 } };
    const context = {
      getChannelRef: () => ({ ack }),
      getMessage: () => message,
    } as unknown as RmqContext;

    ackOnce(context);
    ackOnce(context);

    expect(ack).toHaveBeenCalledTimes(1);
  });
});

describe('RmqAckInterceptor', () => {
  let ack: jest.Mock;
  let message: object;
  const interceptor = new RmqAckInterceptor();

  const rpcContext = (type = 'rpc') =>
    ({
      getType: () => type,
      switchToRpc: () => ({
        getContext: () => ({
          getChannelRef: () => ({ ack }),
          getMessage: () => message,
        }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    ack = jest.fn();
    message = { fields: { deliveryTag: 1 } };
  });

  /**
   * The case that wedged identity: the ValidationPipe refuses the payload, no
   * handler runs, and nothing acked the message.
   */
  it('acks a message whose payload failed validation before any handler ran', async () => {
    const refused = new BadRequestException(['correlationId is too long']);

    await expect(
      lastValueFrom(
        interceptor.intercept(rpcContext(), {
          handle: () => throwError(() => refused),
        }),
      ),
    ).rejects.toBe(refused);

    expect(ack).toHaveBeenCalledWith(message);
  });

  it('acks a handled one too', async () => {
    await lastValueFrom(
      interceptor.intercept(rpcContext(), { handle: () => of('reply') }),
    );

    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('leaves HTTP alone', async () => {
    await lastValueFrom(
      interceptor.intercept(rpcContext('http'), { handle: () => of('ok') }),
    );

    expect(ack).not.toHaveBeenCalled();
  });
});
