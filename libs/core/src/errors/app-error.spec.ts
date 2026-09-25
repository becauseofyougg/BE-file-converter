import { ERROR_CODES } from '@contracts/errors/error-codes';

import { AppError, isSerializedAppError, serializeAppError } from './app-error';

describe('AppError', () => {
  it('carries the code, the status and the details a caller acts on', () => {
    const error = new AppError(ERROR_CODES.RATE_LIMITED, 'Too many', 429, {
      retryAfterSeconds: 60,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(error.httpStatus).toBe(429);
    expect(error.details).toEqual({ retryAfterSeconds: 60 });
  });

  /**
   * `instanceof` is how `settleRpc` tells a business refusal from a crash, and
   * how the filters decide whether a failure is expected. Extending `Error`
   * without setting `name` leaves both working but the logs unreadable.
   */
  it('is named, so a log line says what kind of failure it was', () => {
    expect(new AppError(ERROR_CODES.FORBIDDEN, 'No', 403).name).toBe(
      'AppError',
    );
  });
});

describe('serializeAppError', () => {
  it('keeps what the other side needs to rebuild the failure', () => {
    const serialized = serializeAppError(
      new AppError(ERROR_CODES.USER_NOT_FOUND, 'User not found', 404),
    );

    expect(serialized).toEqual({
      code: ERROR_CODES.USER_NOT_FOUND,
      message: 'User not found',
      httpStatus: 404,
    });
  });

  /**
   * Omitted rather than sent as `undefined`: the payload is JSON on a queue,
   * and `{"details":undefined}` is not valid JSON while `undefined` silently
   * becomes `null` — which a client would then have to tell apart from a real
   * null.
   */
  it('leaves `details` out entirely when there are none', () => {
    const serialized = serializeAppError(
      new AppError(ERROR_CODES.FORBIDDEN, 'No', 403),
    );

    expect('details' in serialized).toBe(false);
  });

  it('keeps details when there are some', () => {
    const serialized = serializeAppError(
      new AppError(ERROR_CODES.FIELD_NOT_WRITABLE, 'No', 403, {
        fields: ['email'],
      }),
    );

    expect(serialized.details).toEqual({ fields: ['email'] });
  });
});

describe('isSerializedAppError', () => {
  it('recognises the wire form', () => {
    expect(
      isSerializedAppError({ code: 'X', message: 'y', httpStatus: 400 }),
    ).toBe(true);
  });

  /**
   * The guard runs on whatever comes back over the queue, which is why every
   * one of these has to be false rather than throwing: a malformed reply is a
   * thing that happens, and it must degrade to "not an AppError" so the caller
   * falls through to its generic handling.
   */
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
    ['a number', 42],
    ['an array', []],
    ['an empty object', {}],
    ['a missing status', { code: 'X', message: 'y' }],
    ['a non-numeric status', { code: 'X', message: 'y', httpStatus: '400' }],
    ['a non-string code', { code: 1, message: 'y', httpStatus: 400 }],
  ])('rejects %s', (_label, value) => {
    expect(isSerializedAppError(value)).toBe(false);
  });
});
