import type {
  RbacConfig,
  RbacRoleConfig,
} from '@contracts/messages/rbac.messages';

export type DenialReason =
  | 'no_roles'
  | 'unknown_role'
  | 'unknown_permission'
  | 'unknown_action'
  | 'no_grant';

export interface AccessDecision {
  allowed: boolean;
  reason?: DenialReason;
  /** The role that allowed it — for the audit line. */
  grantedBy?: string;
}

/**
 * The whole of the access rule, as a pure function over a config snapshot.
 *
 * It lives in `libs/core` rather than in either service because both decide:
 * identity answers `rbac.check` for callers holding no cache, and the gateway
 * decides locally against its cached copy. Two implementations of this would
 * eventually disagree, and a disagreement here is a security hole rather than
 * a bug.
 *
 * It **fails closed** at every branch. An unknown permission is a deployment
 * mistake — a route asking for something the config has never heard of — and
 * the safe reading of a mistake is "no".
 */
export function decideAccess(
  config: RbacConfig,
  roles: readonly string[],
  resource: string,
  action: string,
): AccessDecision {
  if (roles.length === 0) {
    return { allowed: false, reason: 'no_roles' };
  }

  const permission = config.permissions.find((p) => p.name === resource);

  if (!permission) {
    return { allowed: false, reason: 'unknown_permission' };
  }

  // An action the permission does not define can never be granted, so asking
  // for it is always a mistake — worth a distinct reason in the log.
  if (!permission.actions.includes(action)) {
    return { allowed: false, reason: 'unknown_action' };
  }

  let sawKnownRole = false;

  for (const roleName of roles) {
    const role = config.roles.find((r) => r.name === roleName);

    if (!role) {
      continue;
    }

    sawKnownRole = true;

    if (roleGrants(role, resource, action)) {
      return { allowed: true, grantedBy: roleName };
    }
  }

  return {
    allowed: false,
    reason: sawKnownRole ? 'no_grant' : 'unknown_role',
  };
}

function roleGrants(
  role: RbacRoleConfig,
  resource: string,
  action: string,
): boolean {
  for (const grant of role.grants) {
    if (grant.permission !== resource) {
      continue;
    }

    // Empty actions means every action the permission defines — the caller
    // has already checked that `action` is one of them.
    if (grant.actions.length === 0 || grant.actions.includes(action)) {
      return true;
    }
  }

  return false;
}

/** An empty config denies everything, which is the right state to boot into. */
export function emptyRbacConfig(): RbacConfig {
  return {
    version: 'empty',
    generatedAt: new Date(0).toISOString(),
    permissions: [],
    roles: [],
  };
}
