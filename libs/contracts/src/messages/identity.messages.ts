import { UserRole } from '../enums/conversion.enums';

/**
 * Request/response patterns served by identity-service over RabbitMQ.
 * The gateway is the only caller.
 */
export const IDENTITY_PATTERNS = {
  REGISTER: 'identity.auth.register',
  VERIFY_EMAIL: 'identity.auth.verify-email',
  RESEND_VERIFICATION: 'identity.auth.resend-verification',
  LOGIN: 'identity.auth.login',
  CONFIRM_LOGIN: 'identity.auth.confirm-login',
  RESEND_LOGIN_CONFIRMATION: 'identity.auth.resend-login-confirmation',
  REFRESH: 'identity.auth.refresh',
  LOGOUT: 'identity.auth.logout',
  FORGOT_PASSWORD: 'identity.auth.forgot-password',
  RESET_PASSWORD: 'identity.auth.reset-password',
  VALIDATE_TOKEN: 'identity.auth.validate-token',
  GET_ME: 'identity.users.get-me',
  UPDATE_ME: 'identity.users.update-me',
} as const;

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface RegisterResponse {
  status: 'registered' | 'confirmation_required';
  userId?: string;
  challengeId?: string;
  expiresAt?: string;
  tokens?: TokenPair;
}

export interface VerifyEmailRequest {
  challengeId?: string;
  code?: string;
  token?: string;
}

export interface VerifyEmailResponse {
  status: 'verified';
  userId: string;
  tokens: TokenPair;
}

/**
 * Either identifier works: the client normally still holds the `challengeId`
 * from registration, and falls back to the email when it does not.
 */
export interface ResendVerificationRequest {
  challengeId?: string;
  email?: string;
}

/**
 * Deliberately says nothing about whether the account exists or is already
 * verified — see docs/REGISTRATION.md §5.4.
 */
export interface ResendVerificationResponse {
  status: 'accepted';
}

/**
 * What a `verification_tokens` row is for. Registration issues the first;
 * password reset reuses the same table and lifecycle.
 */
export const VERIFICATION_TOKEN_TYPES = {
  EMAIL_VERIFICATION: 'email_verification',
  /** A login waiting to be confirmed — docs/AUTHENTICATION.md §1.3. */
  LOGIN_CONFIRMATION: 'login_confirmation',
  /**
   * A pending move to a new address — docs/PROFILE-UPDATE.md §4. The only type
   * that carries a payload: the address being claimed lives on the row, so it
   * cannot be swapped between issuing the code and quoting it back.
   */
  EMAIL_CHANGE: 'email_change',
  /** A pending account erasure — docs/ACCOUNT-DELETION.md §4. */
  ACCOUNT_DELETION: 'account_deletion',
  PASSWORD_RESET: 'password_reset',
} as const;

export type VerificationTokenType =
  (typeof VERIFICATION_TOKEN_TYPES)[keyof typeof VERIFICATION_TOKEN_TYPES];

export type ConfirmationMethod = 'otp' | 'link';

export interface LoginRequest {
  email: string;
  password: string;
  userAgent?: string;
  ip?: string;
}

/**
 * Mirrors RegisterResponse: either a session, or a challenge to complete
 * first. The status is the contract, so a client branches without guessing
 * from which fields happen to be present.
 */
export interface LoginResponse {
  status: 'authenticated' | 'confirmation_required';
  userId?: string;
  challengeId?: string;
  expiresAt?: string;
  tokens?: TokenPair;
}

/** One shape for both methods: an OTP quoted against a challenge, or a link token. */
export interface ConfirmLoginRequest {
  challengeId?: string;
  code?: string;
  token?: string;
  userAgent?: string;
  ip?: string;
}

export interface ConfirmLoginResponse {
  status: 'authenticated';
  userId: string;
  tokens: TokenPair;
}

/** Carried by the `refresh_token` cookie — docs/AUTHORIZATION.md §2. */
export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  status: 'refreshed';
  userId: string;
  tokens: TokenPair;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  /**
   * The gateway sizes the cookie's `maxAge` from this rather than from a TTL of
   * its own, so the cookie and the token cannot drift apart.
   */
  refreshTokenExpiresAt: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  /**
   * Role *names*, as carried by the access token. Plural because a user may
   * hold several — see docs/RBAC.md §1.1 — and because the RBAC evaluator
   * unions the grants of all of them.
   */
  roles: string[];
  emailVerified: boolean;
}

/**
 * The claims the gateway reads off an access token. No email and no personal
 * data: a JWT is signed, not secret.
 */
export interface AccessTokenClaims {
  sub: string;
  roles: string[];
  jti: string;
  iat?: number;
  exp?: number;
}

/**
 * Marks a token as the refresh half of a pair. Two tokens signed with the same
 * algorithm are interchangeable unless something in the payload says otherwise,
 * and a 30-day refresh presented as a 15-minute access token would be a
 * privilege escalation — so the type is checked as well as the signature, and
 * the two are signed with different secrets besides.
 */
export const REFRESH_TOKEN_TYPE = 'refresh';

/**
 * No roles: a refresh token authorises nothing on its own, it only proves which
 * account may be re-issued a session. The roles are re-read from the database
 * at every refresh, which is the one moment a revoked role can take effect —
 * see docs/AUTHORIZATION.md §4.
 */
export interface RefreshTokenClaims {
  sub: string;
  jti: string;
  typ: typeof REFRESH_TOKEN_TYPE;
  iat?: number;
  exp?: number;
}

/** The two roles seeded so the system can boot and so an admin exists. */
export const SYSTEM_ROLES = {
  USER: UserRole.USER,
  ADMIN: UserRole.ADMIN,
} as const;
