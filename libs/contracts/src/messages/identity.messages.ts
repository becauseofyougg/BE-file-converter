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

export interface LoginRequest {
  email: string;
  password: string;
  userAgent?: string;
  ip?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  emailVerified: boolean;
}
