import { ERROR_CODES } from '@contracts/errors/error-codes';
import type {
  SortOrder,
  UserListSort,
} from '@contracts/messages/users.messages';
import { AppError } from '@core/errors/app-error';

/**
 * What a cursor carries — docs/USER-LIST.md §5.
 *
 * The id alone would be enough to resume the walk. The sort and the order ride
 * along so the *next* request can be checked against the one that produced it:
 * a client that changes `sort` halfway through a pagination is asking for a
 * position in one ordering to be interpreted in another, which silently skips
 * and repeats rows. Refusing is the only answer that cannot be wrong.
 */
export interface UserListCursor {
  id: string;
  sort: UserListSort;
  order: SortOrder;
}

/** Why a cursor was refused — carried in the error's details and the log. */
export type CursorRefusal = 'invalid' | 'sort_mismatch' | 'stale';

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: UserListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Opaque to the client, and treated as hostile here: it arrives in a query
 * string, so it is an input like any other. Anything that does not decode into
 * the exact expected shape is a `400`, never a silently ignored cursor — a
 * page that quietly starts from the beginning is worse than an error, because
 * nothing reveals that it happened.
 */
export function decodeCursor(
  raw: string,
  expected: { sort: UserListSort; order: SortOrder },
): UserListCursor {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  // The id is checked for format, not only for being a string: it goes straight
  // into a query against a `uuid` column, where anything else is a driver
  // error — and an untranslated driver error is a 500, not the 400 this is.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as UserListCursor).id !== 'string' ||
    !UUID_PATTERN.test((parsed as UserListCursor).id)
  ) {
    throw invalidCursor();
  }

  const cursor = parsed as UserListCursor;

  if (cursor.sort !== expected.sort || cursor.order !== expected.order) {
    throw cursorRefused(
      'sort_mismatch',
      'The cursor belongs to a different sort order; start the list again',
    );
  }

  return cursor;
}

/**
 * A well-formed cursor whose account no longer exists — the cleanup job deletes
 * accounts left unconfirmed for a week. Resuming from a row that is gone yields
 * an empty page with no next cursor, which reads as the end of the list; this
 * says what actually happened instead.
 */
export function staleCursor(): AppError {
  return cursorRefused(
    'stale',
    'The cursor points at an account that no longer exists; start the list again',
  );
}

function invalidCursor(): AppError {
  return cursorRefused('invalid', 'Invalid cursor');
}

function cursorRefused(reason: CursorRefusal, message: string): AppError {
  return new AppError(ERROR_CODES.VALIDATION_FAILED, message, 400, {
    reason,
  });
}
