import { StreamableFile } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { DownloadableResult } from './conversions.service';

/** Header carrying the history id of the conversion a download came from. */
export const CONVERSION_ID_HEADER = 'x-conversion-id';

/** Every type a conversion can answer with, for the OpenAPI document. */
export const RESULT_TYPES = [
  'text/csv',
  'application/json',
  'application/xml',
  'application/yaml',
  'image/png',
  'image/jpeg',
];

/** A result as the response: its type, `converted.<ext>`, its length, its id. */
export function attachment(
  reply: FastifyReply,
  result: DownloadableResult,
): StreamableFile {
  void reply.header(CONVERSION_ID_HEADER, result.operationId);

  return new StreamableFile(result.stream, {
    type: result.file.contentType,
    disposition: `attachment; filename="${result.file.fileName}"`,
    length: result.file.size,
  });
}
