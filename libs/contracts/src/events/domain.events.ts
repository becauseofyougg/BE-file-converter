/**
 * Facts, published to the `domain.events` topic exchange. A subscriber may
 * appear or disappear without the publisher knowing — that is the point of the
 * split, and the reason events carry data rather than instructions.
 */
export const DOMAIN_EVENTS = {
  USER_REGISTERED: 'user.registered',
  /** A confirmation was sent again for an account that already exists. */
  USER_VERIFICATION_RESENT: 'user.verification_resent',
  /**
   * Someone submitted the registration form for an address that is already
   * verified. The owner is told; the submitter learns nothing — which is what
   * lets the endpoint answer identically either way.
   */
  USER_REGISTRATION_ATTEMPTED: 'user.registration_attempted',
  USER_EMAIL_VERIFIED: 'user.email_verified',
  /** A login is waiting on an emailed code or link. */
  USER_LOGIN_CONFIRMATION_REQUESTED: 'user.login_confirmation_requested',
  /**
   * The RBAC config changed. Enforcement points hold a cached copy and reload
   * on this — which is what makes a rule change apply without a restart.
   */
  RBAC_UPDATED: 'rbac.updated',
  USER_PASSWORD_RESET_REQUESTED: 'user.password_reset_requested',
  CONVERSION_COMPLETED: 'conversion.completed',
  CONVERSION_FAILED: 'conversion.failed',
} as const;

export type DomainEventName =
  (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export interface DomainEventEnvelope<T> {
  eventId: string;
  eventName: DomainEventName;
  occurredAt: string;
  correlationId: string;
  payload: T;
}

export interface UserRegisteredPayload {
  userId: string;
  email: string;
  /** present only when confirmation is enabled */
  confirmation?: {
    method: 'otp' | 'link';
    /** the code or the link token — rendered by notification-service, never logged */
    secret: string;
    expiresAt: string;
  };
}

/** Same shape as a registration send — the mail differs, the data does not. */
export type UserVerificationResentPayload = UserRegisteredPayload;

export interface UserRegistrationAttemptedPayload {
  userId: string;
  email: string;
}

export interface LoginConfirmationRequestedPayload {
  userId: string;
  email: string;
  method: 'otp' | 'link';
  /** The code or link token — rendered by notification-service, never logged. */
  secret: string;
  expiresAt: string;
  /** Shown in the mail so the owner can recognise a login they did not make. */
  userAgent?: string;
  ip?: string;
}

export interface RbacUpdatedPayload {
  /** The new config version, so a listener can skip a reload it already did. */
  version: string;
  /** What changed, for the audit trail. */
  entity: 'role' | 'permission' | 'grant' | 'user_roles';
  operation: 'create' | 'update' | 'delete';
  actorUserId?: string;
}

export interface UserEmailVerifiedPayload {
  userId: string;
  email: string;
}

export interface PasswordResetRequestedPayload {
  userId: string;
  email: string;
  secret: string;
  expiresAt: string;
}

export interface ConversionCompletedPayload {
  jobId: string;
  userId: string;
  resultKey: string;
  resultSize: number;
  durationMs: number;
}

export interface ConversionFailedPayload {
  jobId: string;
  userId: string;
  errorCode: string;
  attempts: number;
}
