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
  /** A user asked to move their account to a new address; sent to the new one. */
  USER_EMAIL_CHANGE_REQUESTED: 'user.email_change_requested',
  /**
   * The address changed. Sent to the **old** one, which is the only way its
   * owner finds out that an account takeover has moved their account away.
   */
  USER_EMAIL_CHANGED: 'user.email_changed',
  /** A user asked to erase their own account and has to confirm it first. */
  USER_DELETION_REQUESTED: 'user.deletion_requested',
  /**
   * An account was erased. Every service holding data for that user is expected
   * to purge its own on this — identity can only empty its own tables.
   */
  USER_DELETED: 'user.deleted',
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

export interface EmailChangeRequestedPayload {
  userId: string;
  /** Where the code or link goes: the address being claimed, not the current one. */
  newEmail: string;
  method: 'otp' | 'link';
  /** The code or link token — rendered by notification-service, never logged. */
  secret: string;
  expiresAt: string;
}

export interface EmailChangedPayload {
  userId: string;
  /** The address that just lost the account, and where this notice goes. */
  previousEmail: string;
  newEmail: string;
  /** Present when an administrator made the change rather than the user. */
  actorUserId?: string;
}

/**
 * Sent to the account's own address. The mail is the second factor: somebody
 * who found an unlocked laptop has the session but not the mailbox.
 */
export interface DeletionRequestedPayload {
  userId: string;
  email: string;
  method: 'otp' | 'link';
  /** The code or link token — rendered by notification-service, never logged. */
  secret: string;
  expiresAt: string;
}

/**
 * The one event that carries personal data *because* it is being destroyed:
 * the address is here so a farewell notice can be sent, and the photo key so
 * whoever owns that bucket can remove the object. Both are gone from the
 * database by the time this is published, which is the point — a consumer that
 * went looking for them afterwards would find nothing.
 */
export interface UserDeletedPayload {
  userId: string;
  /** The address the account had, for the confirmation notice. */
  email: string;
  /** The object to remove from storage, if the account had a photo. */
  photoKey?: string | null;
  deletedAt: string;
  /** Present when an administrator did it rather than the user themselves. */
  actorUserId?: string;
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
