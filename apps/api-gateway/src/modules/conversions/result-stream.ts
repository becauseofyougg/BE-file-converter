import type { Logger } from '@nestjs/common';
import type { Readable } from 'node:stream';

import { AppError } from '@core/errors/app-error';
import type { ConversionResultFile } from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { ObjectNotFoundError } from '@storage/file-storage';
import type { StorageResolver } from '@storage/storage-resolver';

/** A converted file, ready to stream to the client. */
export interface DownloadableResult {
  file: ConversionResultFile;
  stream: Readable;
  operationId: string;
  /** Set on a conversion's own response: whether the result was kept. */
  saved?: boolean;
}

/**
 * Opens a result in whichever storage it was written to — before a single
 * byte of the response is written, so a result that cannot be read is an
 * error response, never a 200 that stops half-way.
 *
 * - The record says there is a file and storage says there is not: the two
 *   have drifted apart. The client gets 410 — the file is gone, and asking
 *   again will not bring it back — and the operators get an error line.
 * - Storage itself failing is 503, which a client may retry.
 */
export async function openResult(
  resolver: StorageResolver,
  file: ConversionResultFile,
  logger: Logger,
): Promise<Readable> {
  try {
    return await resolver
      .forDriver(file.driver)
      .getStream(file.bucket, file.key);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof ObjectNotFoundError) {
      logger.error({
        event: 'conversion.result_missing',
        fileId: file.fileId ?? null,
        driver: file.driver,
      });

      throw new AppError(
        ERROR_CODES.RESULT_EXPIRED,
        'The file is no longer in storage',
        410,
      );
    }

    logger.error({
      event: 'conversion.result_unreadable',
      error: (error as Error).message,
    });

    throw new AppError(
      ERROR_CODES.STORAGE_UNAVAILABLE,
      'The result could not be read',
      503,
    );
  }
}
