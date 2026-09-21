import { Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { throwError } from 'rxjs';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError, serializeAppError } from './app-error';

/**
 * Turns anything thrown inside a message handler into an `RpcException` whose
 * payload the gateway can map back to an HTTP response.
 *
 * Unexpected errors are deliberately flattened to `INTERNAL_ERROR`: the stack
 * trace belongs in this service's logs, not in a reply travelling to a browser,
 * where a driver message like `duplicate key value violates unique constraint
 * "users_email_key"` would leak the schema and confirm an account exists.
 */
@Catch()
export class RpcAppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RpcAppExceptionFilter.name);

  catch(exception: unknown) {
    if (exception instanceof AppError) {
      // Expected: a business rule refused. Logged by the service that raised
      // it, with the context needed to make sense of it.
      return throwError(
        () => new RpcException(serializeAppError(exception) as object),
      );
    }

    if (exception instanceof RpcException) {
      return throwError(() => exception);
    }

    this.logger.error(
      exception instanceof Error ? exception.message : 'Unknown error',
      exception instanceof Error ? exception.stack : undefined,
    );

    return throwError(
      () =>
        new RpcException({
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Internal error',
          httpStatus: 500,
        }),
    );
  }
}
