import type { TokenPair } from '@contracts/messages/identity.messages';

/**
 * Issues a session's credentials and recognises its refresh credential.
 *
 * The rest of identity — registration, login, refresh — asks for a pair and
 * checks a refresh through this, and never learns what either one is. Today
 * that is two JWTs ({@link JwtTokenIssuer}); swapping to asymmetric keys, or to
 * opaque tokens backed by a store, is a new implementation bound to
 * {@link TOKEN_ISSUER} in `TokensModule`, and no caller changes.
 *
 * What an implementation must keep true, because callers rely on it:
 * - `issuePair` returns a **new** pair every time. Rotation is not a separate
 *   path — refresh is this called again.
 * - `verifyRefresh` accepts only a refresh credential it issued. An access
 *   credential presented here must fail: it would otherwise buy a thirty-day
 *   session for a fifteen-minute token.
 * - Every refusal is the same `UNAUTHENTICATED` 401, whatever the reason.
 */
export interface TokenIssuer {
  issuePair(subject: { id: string }, roles: string[]): Promise<TokenPair>;

  /** Who the refresh credential was issued to. Throws on anything else. */
  verifyRefresh(token: string): Promise<RefreshSubject>;
}

/**
 * What a verified refresh proves, and no more. Deliberately not the JWT claims:
 * `jti` and `typ` are how *one* implementation checks itself, not something a
 * caller should ever come to depend on.
 */
export interface RefreshSubject {
  userId: string;
}

export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');
