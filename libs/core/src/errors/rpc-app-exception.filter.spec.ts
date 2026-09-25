import { RpcException } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import { ERROR_CODES } from '@contracts/errors/error-codes';

import { AppError } from './app-error';
import { RpcAppExceptionFilter } from './rpc-app-exception.filter';

describe('RpcAppExceptionFilter', () => {
  let filter: RpcAppExceptionFilter;

  /** The filter returns an observable that errors; this is what it errors with. */
  async function thrownBy(exception: unknown): Promise<unknown> {
    return firstValueFrom(filter.catch(exception)).catch(
      (error: unknown) => error,
    );
  }

  beforeEach(() => {
    filter = new RpcAppExceptionFilter();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  it('puts an AppError on the wire with everything the gateway needs', async () => {
    const error = (await thrownBy(
      new AppError(ERROR_CODES.EMAIL_IN_USE, 'Taken', 409, { field: 'email' }),
    )) as RpcException;

    expect(error).toBeInstanceOf(RpcException);
    expect(error.getError()).toEqual({
      code: ERROR_CODES.EMAIL_IN_USE,
      message: 'Taken',
      httpStatus: 409,
      details: { field: 'email' },
    });
  });

  it('passes an RpcException through untouched', async () => {
    const original = new RpcException('already wrapped');

    await expect(thrownBy(original)).resolves.toBe(original);
  });

  /**
   * The stack belongs in this service's logs, not in a reply travelling to a
   * browser — a driver message would leak the schema and confirm an account
   * exists.
   */
  it('flattens anything else to INTERNAL_ERROR', async () => {
    const error = (await thrownBy(
      new Error('duplicate key value violates constraint "users_email_key"'),
    )) as RpcException;

    expect(error.getError()).toEqual({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      httpStatus: 500,
    });
    expect(JSON.stringify(error.getError())).not.toContain('users_email_key');
  });

  it('logs the unexpected one, so it is not lost', async () => {
    const logger = jest.spyOn(filter['logger'], 'error');

    await thrownBy(new Error('boom'));

    expect(logger).toHaveBeenCalledWith('boom', expect.any(String));
  });

  it('does not log a business refusal as an error', async () => {
    const logger = jest.spyOn(filter['logger'], 'error');

    await thrownBy(new AppError(ERROR_CODES.FORBIDDEN, 'No', 403));

    expect(logger).not.toHaveBeenCalled();
  });

  it('survives something that is not an Error at all', async () => {
    const error = (await thrownBy('a bare string')) as RpcException;

    expect(error.getError()).toMatchObject({
      code: ERROR_CODES.INTERNAL_ERROR,
    });
  });
});
