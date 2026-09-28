import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';

import { RPC_TIMEOUT_MS, sendRpc } from './rpc';

describe('sendRpc', () => {
  const clientReturning = (stream: unknown): ClientProxy =>
    ({ send: jest.fn().mockReturnValue(stream) }) as unknown as ClientProxy;

  it('sends the pattern and payload, and resolves the reply', async () => {
    const client = clientReturning(of({ status: 'ok' }));

    await expect(
      sendRpc(client, 'identity.auth.login', { email: 'a@b.c' }),
    ).resolves.toEqual({ status: 'ok' });

    expect(client.send).toHaveBeenCalledWith('identity.auth.login', {
      email: 'a@b.c',
    });
  });

  /**
   * The whole point of the helper. An error crossing the broker arrives as a
   * plain object and has lost its class — without this every downstream
   * refusal would surface to the client as a generic 500.
   */
  it('rebuilds an AppError from the serialized reply', async () => {
    const client = clientReturning(
      throwError(() => ({
        code: ERROR_CODES.EMAIL_ALREADY_REGISTERED,
        message: 'Taken',
        httpStatus: 409,
        details: { field: 'email' },
      })),
    );

    const error = (await sendRpc(client, 'p', {}).catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(ERROR_CODES.EMAIL_ALREADY_REGISTERED);
    expect(error.httpStatus).toBe(409);
    expect(error.details).toEqual({ field: 'email' });
  });

  it('answers 504 when the service does not reply in time', async () => {
    const client = clientReturning(
      timer(50).pipe(mergeMap(() => of('too late'))),
    );

    const error = (await sendRpc(client, 'p', {}, 10).catch(
      (caught: unknown) => caught,
    )) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.httpStatus).toBe(504);
    expect(error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
  });

  /**
   * A reply that does not look like one of ours is a bug, not a refusal —
   * forwarding it would let an unexpected shape dictate the status the client
   * sees.
   */
  it('leaves an unrecognised failure alone', async () => {
    const boom = new Error('socket hang up');
    const client = clientReturning(throwError(() => boom));

    await expect(sendRpc(client, 'p', {})).rejects.toBe(boom);
  });

  it('wraps a thrown non-Error so a caller always gets an Error', async () => {
    const client = clientReturning(throwError(() => 'just a string'));

    await expect(sendRpc(client, 'p', {})).rejects.toThrow(
      'Unknown RPC failure',
    );
  });

  it('defaults to a timeout a waiting HTTP caller can survive', () => {
    expect(RPC_TIMEOUT_MS).toBe(10_000);
  });
});
