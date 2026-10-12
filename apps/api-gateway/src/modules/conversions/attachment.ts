import { StreamableFile } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { DownloadableResult } from './result-stream';

/** Header carrying the history id of the conversion a download came from. */
export const CONVERSION_ID_HEADER = 'x-conversion-id';

/**
 * On a conversion's response: whether the result was kept. `false` after
 * `save=true` means it was larger than saved files may be — the conversion
 * itself succeeded. Absent on downloads, which are saved by definition.
 */
export const RESULT_SAVED_HEADER = 'x-result-saved';

/** Every type a conversion can answer with, for the OpenAPI document. */
export const RESULT_TYPES = [
  'text/csv',
  'application/json',
  'application/xml',
  'application/yaml',
  'image/png',
  'image/jpeg',
];

/** A result as the response: its type, its name, its length, its id. */
export function attachment(
  reply: FastifyReply,
  result: DownloadableResult,
): StreamableFile {
  void reply.header(CONVERSION_ID_HEADER, result.operationId);

  if (result.saved !== undefined) {
    void reply.header(RESULT_SAVED_HEADER, String(result.saved));
  }

  return new StreamableFile(result.stream, {
    type: result.file.contentType,
    disposition: contentDisposition(result.file.fileName),
    length: result.file.size,
  });
}

/**
 * `attachment` with the file's name, in both spellings RFC 6266 has: a plain
 * ASCII `filename` every client reads, and — when the name is not ASCII, say
 * `отчёт.json` — the exact one as `filename*`, which modern clients prefer.
 * Quotes, backslashes and line breaks never reach the header, whatever the
 * name holds.
 */
export function contentDisposition(fileName: string): string {
  const fallback = [...fileName]
    .map((char) => {
      const code = char.charCodeAt(0);

      return code < 32 || code > 126 || char === '"' || char === '\\'
        ? '_'
        : char;
    })
    .join('');

  if (fallback === fileName) {
    return `attachment; filename="${fileName}"`;
  }

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
