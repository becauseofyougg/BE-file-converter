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

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as UserListCursor).id !== 'string'
  ) {
    throw invalidCursor();
  }

  const cursor = parsed as UserListCursor;

  if (cursor.sort !== expected.sort || cursor.order !== expected.order) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'The cursor belongs to a different sort order; start the list again',
      400,
    );
  }

  return cursor;
}

function invalidCursor(): AppError {
  return new AppError(ERROR_CODES.VALIDATION_FAILED, 'Invalid cursor', 400);
}
