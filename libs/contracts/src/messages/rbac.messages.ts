/**
 * RBAC surface served by identity-service, which owns the roles, permissions
 * and grants. The gateway enforces against a cached copy of the config and
 * calls these patterns to read or change it.
 */
export const RBAC_PATTERNS = {
  /** The whole evaluated config — what the gateway caches. */
  GET_CONFIG: 'identity.rbac.get-config',
  /** A single decision, for callers that hold no cache of their own. */
  CHECK: 'identity.rbac.check',

  LIST_ROLES: 'identity.rbac.roles.list',
  CREATE_ROLE: 'identity.rbac.roles.create',
  UPDATE_ROLE: 'identity.rbac.roles.update',
  DELETE_ROLE: 'identity.rbac.roles.delete',

  LIST_PERMISSIONS: 'identity.rbac.permissions.list',
  CREATE_PERMISSION: 'identity.rbac.permissions.create',
  UPDATE_PERMISSION: 'identity.rbac.permissions.update',
  DELETE_PERMISSION: 'identity.rbac.permissions.delete',

  LIST_GRANTS: 'identity.rbac.grants.list',
  CREATE_GRANT: 'identity.rbac.grants.create',
  UPDATE_GRANT: 'identity.rbac.grants.update',
  DELETE_GRANT: 'identity.rbac.grants.delete',

  ASSIGN_USER_ROLES: 'identity.rbac.users.assign-roles',
  GET_USER_ROLES: 'identity.rbac.users.get-roles',
} as const;

/**
 * A required permission, written `resource@action` — `users@read`,
 * `conversions@delete`. One string because it is what a route declares, and
 * splitting it at the declaration site invites two halves drifting apart.
 */
export type PermissionRef = `${string}@${string}`;

export const PERMISSION_SEPARATOR = '@';

export interface ParsedPermissionRef {
  resource: string;
  action: string;
}

/**
 * Returns `null` rather than throwing: a malformed reference is a deployment
 * mistake, and the guard's job is to deny it and say so, not to 500.
 */
export function parsePermissionRef(
  reference: string,
): ParsedPermissionRef | null {
  const separator = reference.indexOf(PERMISSION_SEPARATOR);

  if (separator <= 0 || separator === reference.length - 1) {
    return null;
  }

  return {
    resource: reference.slice(0, separator),
    action: reference.slice(separator + 1),
  };
}

// --- the cached config ------------------------------------------------------

export interface RbacPermissionConfig {
  /** The resource, e.g. `users`. */
  name: string;
  /** Every action this resource defines, e.g. `['read', 'create']`. */
  actions: string[];
}

export interface RbacGrantConfig {
  permission: string;
  /**
   * Empty means *every* action the permission defines — the spec's "if no
   * action is given, all of them are available". Stored empty rather than
   * expanded, so a later action added to the permission is picked up without
   * revisiting each grant.
   */
  actions: string[];
}

export interface RbacRoleConfig {
  name: string;
  grants: RbacGrantConfig[];
}

/**
 * Keyed by name, not id: the gateway evaluates against role names taken from
 * the access token, and never sees an id.
 */
export interface RbacConfig {
  /**
   * Changes whenever anything in the config does. The gateway logs it on every
   * reload, so "which rules was that 403 decided by" has an answer.
   */
  version: string;
  generatedAt: string;
  permissions: RbacPermissionConfig[];
  roles: RbacRoleConfig[];
}

// --- admin operations -------------------------------------------------------

export interface RoleDto {
  id: string;
  name: string;
  description: string | null;
  /** System roles are seeded and cannot be renamed or deleted. */
  isSystem: boolean;
}

export interface PermissionDto {
  id: string;
  name: string;
  actions: string[];
}

export interface GrantDto {
  id: string;
  roleId: string;
  roleName: string;
  permissionId: string;
  permissionName: string;
  actions: string[];
}

export interface CheckAccessRequest {
  roles: string[];
  permission: string;
  action: string;
}

export interface CheckAccessResponse {
  allowed: boolean;
  /** Why it was refused — for the audit log, never for the client. */
  reason?: string;
}
