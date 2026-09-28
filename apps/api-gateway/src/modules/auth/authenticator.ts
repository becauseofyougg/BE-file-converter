import type { FastifyRequest } from 'fastify';

import type { RequestUser } from './request-user';

/**
 * One way of proving who a request comes from.
 *
 * `AuthenticationGuard` asks each registered authenticator in turn, so adding
 * a scheme — API keys, a second token issuer, an external IdP — is a new class
 * in the {@link AUTHENTICATORS} list, not an edit to the guard or to anything
 * downstream of it.
 *
 * The three answers mean different things, and the difference is a security
 * property:
 *
 * - **`null`** — "this request carries nothing I recognise". The next
 *   authenticator is asked.
 * - **a `RequestUser`** — authenticated. The chain stops.
 * - **throw** (an `AppError`, 401) — "it carries my kind of credential, and it
 *   is bad". The chain stops *and fails*. A forged or expired credential must
 *   not fall through to a later, possibly weaker, scheme that might accept the
 *   request on other grounds.
 */
export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<RequestUser | null>;
}

/**
 * The ordered list the guard walks. Order is precedence: the first
 * authenticator to recognise a credential decides.
 */
export const AUTHENTICATORS = Symbol('AUTHENTICATORS');
