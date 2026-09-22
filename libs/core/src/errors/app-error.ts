import { ErrorCode } from '@contracts/errors/error-codes';

/**
 * A failure a caller is meant to act on, carrying the stable `code` the client
 * branches on plus the HTTP status the gateway should answer with.
 *
 * Domain services throw this rather than `HttpException`: identity-service has
 * no HTTP surface of its own, and the status is a property of the failure, not
 * of the transport that happens to report it. `RpcAppExceptionFilter` puts it
 * on the wire and the gateway turns it back into an HTTP response, so the code
 * chosen here is the code the browser sees.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * The wire form of an `AppError`. Kept structural rather than a class because
 * it crosses a serialisation boundary — the gateway receives a plain object.
 */
export interface SerializedAppError {
  code: ErrorCode;
  message: string;
  httpStatus: number;
  details?: unknown;
}

export function serializeAppError(error: AppError): SerializedAppError {
  return {
    code: error.code,
    message: error.message,
    httpStatus: error.httpStatus,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export function isSerializedAppError(
  value: unknown,
): value is SerializedAppError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<SerializedAppError>;

  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.httpStatus === 'number'
  );
}
