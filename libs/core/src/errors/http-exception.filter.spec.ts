import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

import { ERROR_CODES, type ErrorResponse } from '@contracts/errors/error-codes';
import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';

import { AppError } from './app-error';
import { HttpAppExceptionFilter } from './http-exception.filter';

describe('HttpAppExceptionFilter', () => {
  let filter: HttpAppExceptionFilter;
  let reply: { status: jest.Mock; header: jest.Mock; send: jest.Mock };

  function hostFor(headers: Record<string, string> = {}): ArgumentsHost {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers, id: 'req-1' }),
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost;
  }

  const sent = () => reply.send.mock.calls[0][0] as ErrorResponse;
  const status = () => reply.status.mock.calls[0][0] as number;

  beforeEach(() => {
    reply = {
      status: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };
    filter = new HttpAppExceptionFilter();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  describe('an AppError', () => {
    it('answers with its own code, status and details', () => {
      filter.catch(
        new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'Locked', 429, {
          retryAfterSeconds: 900,
        }),
        hostFor(),
      );

      expect(status()).toBe(429);
      expect(sent()).toMatchObject({
        code: ERROR_CODES.ACCOUNT_LOCKED,
        message: 'Locked',
        details: { retryAfterSeconds: 900 },
      });
    });
  });

  describe('a Nest HttpException', () => {
    /**
     * `ValidationPipe` throws a `BadRequestException` whose payload is an array
     * of constraint messages. They are worth keeping — they say which field
     * failed and how, without echoing the value that failed.
     */
    it('turns validation messages into VALIDATION_FAILED with the details', () => {
      filter.catch(
        new BadRequestException({
          message: ['email must be an email', 'password is too short'],
        }),
        hostFor(),
      );

      expect(status()).toBe(400);
      expect(sent()).toMatchObject({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Validation failed',
        details: ['email must be an email', 'password is too short'],
      });
    });

    it('maps a bare 403 to FORBIDDEN', () => {
      filter.catch(new ForbiddenException(), hostFor());

      expect(sent().code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('maps a bare 429 to RATE_LIMITED', () => {
      filter.catch(
        new HttpException('Too many', HttpStatus.TOO_MANY_REQUESTS),
        hostFor(),
      );

      expect(sent().code).toBe(ERROR_CODES.RATE_LIMITED);
    });

    it('falls back to INTERNAL_ERROR for a status it has no code for', () => {
      filter.catch(
        new HttpException('Teapot', HttpStatus.I_AM_A_TEAPOT),
        hostFor(),
      );

      expect(sent().code).toBe(ERROR_CODES.INTERNAL_ERROR);
    });
  });

  describe('anything else', () => {
    /**
     * A bug is not a message for a caller. A driver error like `duplicate key
     * value violates unique constraint "users_email_key"` would leak the schema
     * and confirm an account exists.
     */
    it('answers 500 with nothing of the original in it', () => {
      filter.catch(
        new Error('duplicate key value violates constraint "users_email_key"'),
        hostFor(),
      );

      expect(status()).toBe(500);
      expect(sent()).toMatchObject({
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
      });
      expect(JSON.stringify(sent())).not.toContain('users_email_key');
    });

    it('logs the real error, so it is not lost', () => {
      const logger = jest.spyOn(filter['logger'], 'error');

      filter.catch(new Error('boom'), hostFor());

      expect(logger).toHaveBeenCalledWith('boom', expect.any(String));
    });

    it('does not log a business refusal as an error', () => {
      const logger = jest.spyOn(filter['logger'], 'error');

      filter.catch(new AppError(ERROR_CODES.FORBIDDEN, 'No', 403), hostFor());

      expect(logger).not.toHaveBeenCalled();
    });
  });

  describe('the correlation id', () => {
    it('echoes the inbound header, in the body and in a header', () => {
      filter.catch(
        new AppError(ERROR_CODES.FORBIDDEN, 'No', 403),
        hostFor({ [CORRELATION_ID_HEADER]: 'trace-abc' }),
      );

      expect(sent().correlationId).toBe('trace-abc');
      expect(reply.header).toHaveBeenCalledWith(
        CORRELATION_ID_HEADER,
        'trace-abc',
      );
    });

    it('falls back to the request id when the caller sent none', () => {
      filter.catch(new AppError(ERROR_CODES.FORBIDDEN, 'No', 403), hostFor());

      expect(sent().correlationId).toBe('req-1');
    });
  });
});
