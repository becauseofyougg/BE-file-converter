/**
 * Reading a user's profile — docs/USER-PROFILE.md.
 *
 * Two shapes, deliberately not one: identity returns an object-storage *key*
 * for the photo, and the gateway is what turns that into a presigned URL. If
 * the swap is ever forgotten the public response simply has no `photo` field,
 * rather than an internal key where a URL should be.
 */

export const USERS_PATTERNS = {
  GET_PROFILE: 'identity.users.get-profile',
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
  photoKey?: string | null;
  emailVerified?: boolean;
  createdAt?: string;
  roles?: string[];
}

/** gateway → client. `photo` is a short-lived presigned URL, or null. */
export interface UserProfile {
  id: string;
  email?: string;
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
    'photo',
    'emailVerified',
    'createdAt',
    'roles',
  ],
  [PROFILE_AUDIENCES.OTHER]: [
    'id',
    'email',
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
