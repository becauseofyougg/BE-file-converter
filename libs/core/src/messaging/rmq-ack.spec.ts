import type { RmqContext } from '@nestjs/microservices';

import { ERROR_CODES } from '@contracts/errors/error-codes';

import { AppError } from '../errors/app-error';
import { settleRpc } from './rmq-ack';

describe('settleRpc', () => {
  let ack: jest.Mock;
  let context: RmqContext;
  const message = { fields: { deliveryTag: 1 } };

  beforeEach(() => {
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
   * The opposite case, and the reason `noAck: false` is worth the bookkeeping:
   * a dropped connection or a crashed process leaves the message on the queue,
   * where a redelivery has a real chance of succeeding.
   */
  it('leaves anything else unacked, so the broker redelivers it', async () => {
    const crash = new Error('connection lost');

    await expect(settleRpc(context, () => Promise.reject(crash))).rejects.toBe(
      crash,
    );

    expect(ack).not.toHaveBeenCalled();
  });

  it('rethrows rather than swallowing, so the reply still carries the failure', async () => {
    await expect(
      settleRpc(context, () =>
        Promise.reject(new AppError(ERROR_CODES.FORBIDDEN, 'No', 403)),
      ),
    ).rejects.toThrow(AppError);
  });
});
