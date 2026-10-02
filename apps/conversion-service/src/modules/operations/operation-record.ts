import type { ConversionOperation } from '@prisma-clients/conversion';

import type { ConversionOperationRecord } from '@contracts/messages/conversion.messages';

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
    saved: row.saved,
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

/** Only a saved result is offered from the history; an unsaved one is transient. */
export function isDownloadable(row: ConversionOperation): boolean {
  return row.status === 'COMPLETED' && row.saved && row.resultKey !== null;
}

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
