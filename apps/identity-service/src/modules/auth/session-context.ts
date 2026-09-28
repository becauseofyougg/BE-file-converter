/**
 * Where a request came from, as the gateway saw it. Shown in the login
 * confirmation mail so the owner can recognise a sign-in that is not theirs.
 */
export interface SessionContext {
  userAgent?: string;
  ip?: string;
}
