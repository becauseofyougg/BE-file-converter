import type { IncomingMessage } from 'node:http';

const USER_ID = Symbol('observability.userId');

type TaggedRequest = IncomingMessage & { [USER_ID]?: string };

/**
 * Names the caller on the request's own log line. pino-http evaluates
 * `customProps` again when the response finishes, so whatever authenticates the
 * request in between can attribute it — without this, the "request completed"
 * line records that a protected route was hit but not by whom.
 *
 * The raw Node request, not Fastify's wrapper around it: pino-http runs as
 * middleware and only ever sees the former. A symbol rather than a property
 * name, so nothing else on the request can collide with it or read it by
 * accident.
 */
export function attachUserToRequestLog(
  req: IncomingMessage,
  userId: string,
): void {
  (req as TaggedRequest)[USER_ID] = userId;
}

export function requestLogUserId(req: IncomingMessage): string | undefined {
  return (req as TaggedRequest)[USER_ID];
}
