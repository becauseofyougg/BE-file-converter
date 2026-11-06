import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { pipeline, type Readable, Transform } from 'node:stream';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';

/** What a multipart request held, once its file has gone to storage. */
export interface ReadUpload {
  fileName: string;
  size: number;
  fields: Record<string, string>;
}

/**
 * Reads a `multipart/form-data` request, handing the one file part to
 * `store` as a stream the moment it arrives — before any later field, so the
 * fields may come in either order without the file being held anywhere.
 *
 * Refusals: not multipart, no file, more than one, or a file over the edge's
 * ceiling (413, from the plugin's `fileSize` limit). `store` sees a stream
 * that errors in that last case, and must not leave a partial object behind
 * — the caller deletes it.
 */
export async function readUpload(
  request: FastifyRequest,
  store: (body: Readable) => Promise<void>,
  maxBytes: number,
): Promise<ReadUpload> {
  if (!request.isMultipart()) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Send the file as multipart/form-data, in a part named "file"',
      400,
    );
  }

  const fields: Record<string, string> = {};
  let file: { fileName: string; size: number } | null = null;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = fieldValue(part);
        continue;
      }

      if (part.fieldname !== 'file' || file) {
        // Drained, or the request stalls waiting for it to be read.
        part.file.resume();
        throw new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          'Send exactly one file, in a part named "file"',
          400,
        );
      }

      file = {
        fileName: part.filename,
        size: await storeCounted(part, store, maxBytes),
      };
    }
  } catch (error) {
    throw asUploadError(error, maxBytes);
  }

  if (!file) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Send the file in a part named "file"',
      400,
    );
  }

  return { ...file, fields };
}

/** Streams the part through a byte counter into `store`; resolves to the count. */
async function storeCounted(
  part: MultipartFile,
  store: (body: Readable) => Promise<void>,
  maxBytes: number,
): Promise<number> {
  let size = 0;

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(null, chunk);
    },
  });

  // `pipeline`, not `pipe`: an error on the upload — the size limit — has to
  // reach the counter, and through it whatever `store` is writing to.
  pipeline(part.file, counter, () => undefined);

  await store(counter);

  if (part.file.truncated) {
    throw tooLarge(maxBytes);
  }

  return size;
}

function fieldValue(part: MultipartValue): string {
  return typeof part.value === 'string' ? part.value : String(part.value);
}

function asUploadError(error: unknown, maxBytes: number): unknown {
  const code = (error as { code?: string } | null)?.code;

  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return tooLarge(maxBytes);
  }

  if (
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_FIELDS_LIMIT' ||
    code === 'FST_PARTS_LIMIT'
  ) {
    return new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Send one file, in a part named "file", and the documented fields',
      400,
    );
  }

  return error;
}

function tooLarge(maxBytes: number): AppError {
  return new AppError(
    ERROR_CODES.FILE_TOO_LARGE,
    `Uploads are accepted up to ${maxBytes} bytes`,
    413,
    { maxBytes },
  );
}
