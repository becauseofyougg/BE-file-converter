import { randomUUID } from 'node:crypto';

import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';

/**
 * What a caller-supplied correlation id may look like: short, and made of
 * characters that are safe in a log line, a response header and an AMQP header
 * alike. A UUID fits; so does anything an upstream proxy sensibly generates.
 */
const ACCEPTABLE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * The caller's `x-correlation-id`, if it is one we are willing to carry.
 *
 * The header comes from the client, unauthenticated, and used to be forwarded
 * verbatim into every RPC. Identity validates the field — rightly — and one
 * request with a 65-character header failed that validation before any handler
 * ran, left its message unacknowledged, and so stopped identity answering
 * anyone at all. Refusing the header here is the edge's half of that fix; the
 * consumer settling every message is the other.
 */
export function acceptCorrelationId(value: unknown): string | undefined {
  return typeof value === 'string' && ACCEPTABLE.test(value)
    ? value
    : undefined;
}

/** The request's correlation id: the caller's when acceptable, else our own. */
export function correlationIdFor(request: {
  headers: Record<string, unknown>;
  id?: string;
}): string {
  return (
    acceptCorrelationId(request.headers[CORRELATION_ID_HEADER]) ??
    request.id ??
    randomUUID()
  );
}
