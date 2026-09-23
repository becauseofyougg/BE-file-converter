/**
 * Reading a user's profile — docs/USER-PROFILE.md.
 *
 * Two shapes, deliberately not one: identity returns an object-storage *key*
 * for the photo, and the gateway is what turns that into a presigned URL. If
 * the swap is ever forgotten the public response simply has no `photo` field,
 * rather than an internal key where a URL should be.
 */

import type { ConfirmationMethod } from './identity.messages';

export const USERS_PATTERNS = {
  GET_PROFILE: 'identity.users.get-profile',
  UPDATE_PROFILE: 'identity.users.update-profile',
  START_EMAIL_CHANGE: 'identity.users.start-email-change',
  CONFIRM_EMAIL_CHANGE: 'identity.users.confirm-email-change',
} as const;

export interface GetUserProfileRequest {
  /** Whose profile is being asked for. */
  targetUserId: string;

  /** Who is asking. Taken from the access token, never from the body. */
  viewerUserId: string;

  /** The viewer's roles, as carried by their access token. */
  viewerRoles: string[];

  correlationId?: string;
}

/** identity → gateway. `photoKey` is a storage key, not a URL. */
export interface UserProfileRecord {
  id: string;
  email?: string;
  displayName?: string | null;
  photoKey?: string | null;
  emailVerified?: boolean;
  createdAt?: string;
  roles?: string[];
}

/** gateway → client. `photo` is a short-lived presigned URL, or null. */
export interface UserProfile {
  id: string;
  email?: string;
  displayName?: string | null;
  photo?: string | null;
  emailVerified?: boolean;
  createdAt?: string;
  roles?: string[];
}

/**
 * Who is looking. `self` is an ownership fact, not a role — see
 * docs/USER-PROFILE.md §3 for why the two are decided separately.
 */
export const PROFILE_AUDIENCES = {
  SELF: 'self',
  OTHER: 'other',
} as const;

export type ProfileAudience =
  (typeof PROFILE_AUDIENCES)[keyof typeof PROFILE_AUDIENCES];

/**
 * The field allow-list, per audience — the policy the requirement asks to be
 * fixed (§1.3.1). Everything not named here is withheld, and the filter walks
 * *this list* rather than the record's own keys, so a column added to the model
 * later is invisible until someone adds it here on purpose. That is the whole
 * mechanism behind "default-deny": forgetting to update it leaks nothing.
 *
 * `roles` is withheld from `other` on purpose. Knowing which accounts hold
 * ADMIN is reconnaissance, and an administrator who legitimately needs that
 * view has `/admin/rbac/*`, which exposes it deliberately.
 */
export const PROFILE_FIELD_POLICY: Record<
  ProfileAudience,
  readonly (keyof UserProfile)[]
> = {
  [PROFILE_AUDIENCES.SELF]: [
    'id',
    'email',
    'displayName',
    'photo',
    'emailVerified',
    'createdAt',
    'roles',
  ],
  [PROFILE_AUDIENCES.OTHER]: [
    'id',
    'email',
    'displayName',
    'photo',
    'emailVerified',
    'createdAt',
  ],
};

/**
 * The permission that lets someone read a profile that is not their own.
 * Self-access does not consult it — §3.
 */
export const PROFILE_READ_PERMISSION = { resource: 'users', action: 'read' };

/** And the one that lets them change it. */
export const PROFILE_UPDATE_PERMISSION = {
  resource: 'users',
  action: 'update',
};

/**
 * What `PATCH /users/:userId` accepts. `null` clears an optional field;
 * omitting it leaves it alone, which is the difference a PATCH exists to
 * express.
 */
export interface UserPatch {
  displayName?: string | null;
  email?: string;
}

export const DISPLAY_NAME_MAX_LENGTH = 64;

/**
 * The writable field allow-list, per audience — the set §1.3.1 asks to be
 * fixed. Default-deny: a field absent from the audience's row is refused, not
 * ignored, so a client learns its change did not happen.
 *
 * **Self cannot set `email` here**, which is the requirement's central rule:
 * moving an account to a new address has to be proved against that address, so
 * it goes through the challenge flow instead. An administrator can, because the
 * point of the administrative path is to rescue someone who has lost the
 * mailbox they would otherwise have to prove.
 *
 * **Nobody can set `photo` here**, in either role. It is an object-storage key,
 * and a client that could write one at will could point its own profile at any
 * object in the bucket and be handed a presigned URL for it. The key is written
 * server-side by the upload endpoint, when that exists.
 */
export const PROFILE_PATCH_POLICY: Record<
  ProfileAudience,
  readonly (keyof UserPatch)[]
> = {
  [PROFILE_AUDIENCES.SELF]: ['displayName'],
  [PROFILE_AUDIENCES.OTHER]: ['displayName', 'email'],
};

export interface UpdateUserProfileRequest {
  targetUserId: string;
  viewerUserId: string;
  viewerRoles: string[];
  patch: UserPatch;
  correlationId?: string;
}

export interface StartEmailChangeRequest {
  targetUserId: string;
  viewerUserId: string;
  newEmail: string;
  correlationId?: string;
}

export interface StartEmailChangeResponse {
  requiresConfirmation: true;
  challengeId: string;
  method: ConfirmationMethod;
  expiresAt: string;
}

/** One shape for both methods: an OTP quoted against a challenge, or a link token. */
export interface ConfirmEmailChangeRequest {
  targetUserId: string;
  challengeId?: string;
  code?: string;
  token?: string;
  correlationId?: string;
}

export interface ConfirmEmailChangeResponse {
  status: 'email_changed';
  userId: string;
  email: string;
}
