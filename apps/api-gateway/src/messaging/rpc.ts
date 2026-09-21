import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout, TimeoutError } from 'rxjs';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError, isSerializedAppError } from '@core/errors/app-error';

/** A caller waiting on an HTTP request cannot wait longer than this. */
export const RPC_TIMEOUT_MS = 10_000;

/**
 * Sends a request/response message and restores the typed failure on the
 * other side.
 *
 * Without the mapping every downstream refusal — a duplicate email, an expired
 * code — would surface as a generic 500, because an error crossing the broker
 * arrives as a plain object and loses its class. A reply that does not look
 * like one of ours is treated as a bug rather than forwarded, so an unexpected
 * shape cannot dictate the status code the client sees.
 */
export async function sendRpc<TResponse, TPayload extends object>(
  client: ClientProxy,
  pattern: string,
  payload: TPayload,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<TResponse> {
  try {
    return await lastValueFrom(
      client
        .send<TResponse, TPayload>(pattern, payload)
        .pipe(timeout(timeoutMs)),
    );
  } catch (error) {
    throw toAppError(error);
  }
}

function toAppError(error: unknown): Error {
  if (isSerializedAppError(error)) {
    return new AppError(
      error.code,
      error.message,
      error.httpStatus,
      error.details,
    );
  }

  if (error instanceof TimeoutError) {
    // The service may still be processing; 504 says "ask again", which for a
    // registration is safe — the unique index makes a repeat harmless.
    return new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      'The service did not respond in time',
      504,
    );
  }

  return error instanceof Error ? error : new Error('Unknown RPC failure');
}
