/**
 * Facts, published to the `domain.events` topic exchange. A subscriber may
 * appear or disappear without the publisher knowing — that is the point of the
 * split, and the reason events carry data rather than instructions.
 */
export const DOMAIN_EVENTS = {
  USER_REGISTERED: 'user.registered',
  USER_EMAIL_VERIFIED: 'user.email_verified',
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
