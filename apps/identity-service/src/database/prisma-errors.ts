import { Prisma } from '@prisma-clients/identity';

/**
 * Postgres `23505`, as Prisma reports it.
 *
 * A `SELECT` before the write cannot stand in for this: two requests both pass
 * it before either inserts, and only the unique index sees them both. Left
 * untranslated, the loser's error reaches the RPC filter as an unknown one and
 * goes out as a 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Awaits a write, turning a unique-index refusal into `conflict()` — the same
 * 409 the pre-check would have produced, had it seen the other request.
 */
export async function orConflict<T>(
  write: PromiseLike<T>,
  conflict: () => Error,
): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict();
    }

    throw error;
  }
}
