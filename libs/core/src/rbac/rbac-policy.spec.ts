import type { RbacConfig } from '@contracts/messages/rbac.messages';
import { decideAccess, emptyRbacConfig } from './rbac-policy';

const config: RbacConfig = {
  version: 'test',
  generatedAt: new Date().toISOString(),
  permissions: [
    { name: 'users', actions: ['read', 'update', 'delete'] },
    { name: 'conversions', actions: ['create', 'read', 'delete'] },
    { name: 'rbac', actions: ['read', 'manage'] },
  ],
  roles: [
    {
      name: 'USER',
      grants: [
        { permission: 'users', actions: ['read', 'update'] },
        { permission: 'conversions', actions: [] },
      ],
    },
    {
      name: 'AUDITOR',
      grants: [{ permission: 'rbac', actions: ['read'] }],
    },
    {
      name: 'ADMIN',
      grants: [
        { permission: 'users', actions: [] },
        { permission: 'conversions', actions: [] },
        { permission: 'rbac', actions: [] },
      ],
    },
  ],
};

describe('decideAccess', () => {
  it('allows an action the role names explicitly', () => {
    expect(decideAccess(config, ['USER'], 'users', 'read')).toEqual({
      allowed: true,
      grantedBy: 'USER',
    });
  });

  it('refuses an action the role does not name', () => {
    expect(decideAccess(config, ['USER'], 'users', 'delete')).toEqual({
      allowed: false,
      reason: 'no_grant',
    });
  });

  /** §1.3.4: an empty action list means every action of the permission. */
  it('treats an empty grant as every action of the permission', () => {
    for (const action of ['create', 'read', 'delete']) {
      expect(
        decideAccess(config, ['USER'], 'conversions', action).allowed,
      ).toBe(true);
    }
  });

  it('still refuses an action the permission never defined, even on an empty grant', () => {
    expect(decideAccess(config, ['ADMIN'], 'users', 'approve')).toEqual({
      allowed: false,
      reason: 'unknown_action',
    });
  });

  /** §1.1: a user may hold several roles, and the grants union. */
  it('unions the grants of every role held', () => {
    expect(decideAccess(config, ['USER', 'AUDITOR'], 'rbac', 'read')).toEqual({
      allowed: true,
      grantedBy: 'AUDITOR',
    });
  });

  it('reports which role allowed it', () => {
    expect(
      decideAccess(config, ['AUDITOR', 'ADMIN'], 'rbac', 'manage').grantedBy,
    ).toBe('ADMIN');
  });

  it('ignores a role that is not in the config rather than failing', () => {
    expect(decideAccess(config, ['GHOST', 'USER'], 'users', 'read')).toEqual({
      allowed: true,
      grantedBy: 'USER',
    });
  });

  describe('failing closed', () => {
    it('refuses when the user holds no roles', () => {
      expect(decideAccess(config, [], 'users', 'read')).toEqual({
        allowed: false,
        reason: 'no_roles',
      });
    });

    it('refuses when every role is unknown', () => {
      expect(decideAccess(config, ['GHOST'], 'users', 'read')).toEqual({
        allowed: false,
        reason: 'unknown_role',
      });
    });

    /**
     * A route asking for something the config has never heard of is a
     * deployment mistake. The safe reading of a mistake is "no".
     */
    it('refuses an unknown permission', () => {
      expect(decideAccess(config, ['ADMIN'], 'nonexistent', 'read')).toEqual({
        allowed: false,
        reason: 'unknown_permission',
      });
    });

    it('refuses everything against an empty config', () => {
      expect(
        decideAccess(emptyRbacConfig(), ['ADMIN'], 'users', 'read').allowed,
      ).toBe(false);
    });
  });

  it('does not treat an action as a prefix or substring match', () => {
    expect(decideAccess(config, ['AUDITOR'], 'rbac', 'rea').allowed).toBe(
      false,
    );
    expect(decideAccess(config, ['AUDITOR'], 'rbac', 'read_all').allowed).toBe(
      false,
    );
  });
});
