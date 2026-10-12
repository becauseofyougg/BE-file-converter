import type { ConversionOperation } from '@prisma-clients/conversion';

import {
  type ConversionOperationRecord,
  type ConversionOptions,
  type TransformationHistoryItem,
  transformationType,
} from '@contracts/messages/conversion.messages';

/** A row as the history shows it: no keys, no driver, no correlation id. */
export function toOperationRecord(
  row: ConversionOperation,
): ConversionOperationRecord {
  return {
    id: row.id,
    status: row.status,
    source: {
      name: row.sourceName,
      format: row.sourceFormat,
      size: Number(row.sourceSize),
      checksum: row.sourceChecksum,
    },
    target: {
      format: row.targetFormat,
      size: row.resultSize === null ? null : Number(row.resultSize),
      checksum: row.resultChecksum,
    },
    options: (row.options as ConversionOptions | null) ?? null,
    saved: row.saved,
    fileId: isDownloadable(row) ? row.fileId : null,
    resultAvailable: isDownloadable(row),
    error:
      row.errorCode === null
        ? null
        : { code: row.errorCode, message: row.errorMessage ?? '' },
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** A finished row as the transformation history shows it — docs/TRANSFORMATION-HISTORY.md. */
export function toHistoryItem(
  row: ConversionOperation,
): TransformationHistoryItem {
  return {
    id: row.id,
    type: transformationType(row.family),
    sourceFormat: row.sourceFormat,
    targetFormat: row.targetFormat,
    status: row.status === 'COMPLETED' ? 'success' : 'error',
    fileSize: Number(row.sourceSize),
    durationMs: row.durationMs ?? 0,
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    fileId: isDownloadable(row) ? row.fileId : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Only a saved result is offered from the history, and only until its time:
 * an unsaved one is transient, and a saved one lasts as long as the history.
 */
export function isDownloadable(
  row: ConversionOperation,
  now = new Date(),
): boolean {
  return (
    row.status === 'COMPLETED' &&
    row.saved &&
    row.resultKey !== null &&
    !hasExpired(row, now)
  );
}

export function hasExpired(
  row: ConversionOperation,
  now = new Date(),
): boolean {
  return row.resultExpiresAt !== null && row.resultExpiresAt <= now;
}

/**
 * What a downloaded result is called: the name it was uploaded under, with
 * the new format's extension — `people.csv` → `people.json`. Kept to the
 * characters a file name can safely have on any system; the original may hold
 * anything a client sent, and it ends up in a header.
 */
export function downloadName(sourceName: string, extension: string): string {
  const fileName = sourceName.split(/[/\\]/).pop() ?? '';
  const stem = fileName.includes('.')
    ? fileName.slice(0, fileName.lastIndexOf('.'))
    : fileName;
  const base = [...stem]
    .map((char) =>
      char.charCodeAt(0) < 32 ||
      char.charCodeAt(0) === 127 ||
      UNSAFE_IN_NAMES.includes(char)
        ? '_'
        : char,
    )
    .join('')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100);

  return `${base || 'converted'}.${extension}`;
}

/** Characters Windows forbids in a file name, plus the quote that ends a header value. */
const UNSAFE_IN_NAMES = '"*:<>?|';

/**
 * History cursors: the position of the last row seen, opaque to the client.
 * `(created_at, id)` rather than an offset, so a conversion finishing while
 * someone pages does not shift every page after it by one.
 */
export function encodeCursor(
  row: Pick<ConversionOperation, 'createdAt' | 'id'>,
): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString(
    'base64url',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  const [stamp, id, ...rest] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  const createdAt = new Date(stamp);

  // The id goes into a uuid column; anything else would be a database error.
  if (
    rest.length > 0 ||
    !UUID.test(id ?? '') ||
    Number.isNaN(createdAt.getTime())
  ) {
    return null;
  }

  return { createdAt, id };
}
