import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

import {
  ERROR_CODES,
  ErrorCode,
  ErrorResponse,
} from '@contracts/errors/error-codes';
import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';
import { AppError } from './app-error';

/**
 * The single exit point for every failure on the public API, so a client can
 * branch on `code` and never on prose or on an HTTP status alone.
 *
 * Only `AppError` and `HttpException` carry a message meant for a caller.
 * Anything else is a bug, and its text stays in the logs.
 */
@Catch()
export class HttpAppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpAppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const correlationId =
      (request.headers?.[CORRELATION_ID_HEADER] as string | undefined) ??
      String(request.id ?? '');

    const { status, body } = this.describe(exception, correlationId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        exception instanceof Error ? exception.message : 'Unknown error',
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    void reply
      .status(status)
      .header(CORRELATION_ID_HEADER, correlationId)
      .send(body);
  }

  private describe(
    exception: unknown,
    correlationId: string,
  ): { status: HttpStatus; body: ErrorResponse } {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus as HttpStatus,
        body: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          correlationId,
        },
      };
    }

    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus() as HttpStatus,
        body: {
          ...this.fromHttpException(exception),
          correlationId,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
        correlationId,
      },
    };
  }

  /**
   * `ValidationPipe` throws a `BadRequestException` whose payload is an array
   * of constraint messages; the throttler guard throws a bare 429. Both need a
   * code, and the field-level messages are worth keeping — they say which
   * field failed and how, without echoing the value that failed.
   */
  private fromHttpException(
    exception: HttpException,
  ): Omit<ErrorResponse, 'correlationId'> {
    const status = exception.getStatus() as HttpStatus;
    const payload: unknown = exception.getResponse();

    const messages =
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as { message?: unknown }).message)
        ? (payload as { message: string[] }).message
        : undefined;

    if (status === HttpStatus.BAD_REQUEST && messages) {
      return {
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Validation failed',
        details: messages,
      };
    }

    return {
      code: this.codeForStatus(status),
      message: exception.message,
    };
  }

  private codeForStatus(status: HttpStatus): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ERROR_CODES.VALIDATION_FAILED;
      case HttpStatus.FORBIDDEN:
        return ERROR_CODES.FORBIDDEN;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ERROR_CODES.RATE_LIMITED;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
}
