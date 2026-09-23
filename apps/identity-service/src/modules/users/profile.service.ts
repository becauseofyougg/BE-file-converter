import { Injectable, Logger } from '@nestjs/common';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  PROFILE_AUDIENCES,
  PROFILE_FIELD_POLICY,
  PROFILE_READ_PERMISSION,
  type GetUserProfileRequest,
  type ProfileAudience,
  type UserProfileRecord,
} from '@contracts/messages/users.messages';
import { AppError } from '@core/errors/app-error';
import { RbacConfigService } from '../rbac/rbac-config.service';
import { UserRolesService } from '../rbac/user-roles.service';
import { UsersService, isEmailVerified, type User } from './users.service';

/**
 * Reading one user's profile — docs/USER-PROFILE.md.
 *
 * The decision lives here rather than in a gateway guard because it is
 * data-dependent: "self **or** `users@read`" cannot be answered by a route
 * decorator, which sees the caller but not who the target turns out to be.
 * Identity holds both the target row and the RBAC config, so it is the one
 * place that can answer without a second round trip or a claim taken on trust.
 */
@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly users: UsersService,
    private readonly userRoles: UserRolesService,
    private readonly rbac: RbacConfigService,
  ) {}

  async getProfile(input: GetUserProfileRequest): Promise<UserProfileRecord> {
    const audience = await this.audienceFor(input);

    // Ordering matters, and this is the load-bearing line of the whole
    // endpoint. Authorisation is settled *before* the target is looked up, so
    // someone without `users@read` gets the same 403 whether or not the id
    // exists. Looking up first and answering 404 would turn this route into an
    // oracle for which user ids are real — an IDOR by another name (§1.6).
    const user = await this.users.findById(input.targetUserId);

    if (!user) {
      this.audit(input, 'not_found', audience);

      throw new AppError(ERROR_CODES.USER_NOT_FOUND, 'User not found', 404);
    }

    this.audit(input, 'ok', audience);

    return await this.project(user, audience);
  }

  private async audienceFor(
    input: GetUserProfileRequest,
  ): Promise<ProfileAudience> {
    if (input.targetUserId === input.viewerUserId) {
      return PROFILE_AUDIENCES.SELF;
    }

    const decision = await this.rbac.check(
      input.viewerRoles,
      PROFILE_READ_PERMISSION.resource,
      PROFILE_READ_PERMISSION.action,
    );

    if (!decision.allowed) {
      this.audit(input, 'forbidden', PROFILE_AUDIENCES.OTHER, decision.reason);

      throw new AppError(ERROR_CODES.FORBIDDEN, 'Access denied', 403);
    }

    return PROFILE_AUDIENCES.OTHER;
  }

  /**
   * Builds the response by walking the **allow-list**, never the record's own
   * keys. A column added to `users` later is therefore invisible here until
   * someone names it in the policy on purpose, which is what makes the
   * default-deny of §1.4 hold by construction rather than by remembering.
   */
  private async project(
    user: User,
    audience: ProfileAudience,
  ): Promise<UserProfileRecord> {
    const record: UserProfileRecord = { id: user.id };

    for (const field of PROFILE_FIELD_POLICY[audience]) {
      switch (field) {
        case 'id':
          break;
        case 'email':
          record.email = user.email;
          break;
        case 'photo':
          // The public field is `photo`; what travels is the storage key, and
          // the gateway presigns it. See users.messages.ts.
          record.photoKey = user.photoKey;
          break;
        case 'emailVerified':
          record.emailVerified = isEmailVerified(user);
          break;
        case 'createdAt':
          record.createdAt = user.createdAt.toISOString();
          break;
        case 'roles':
          // The one field that costs a query, so it is fetched only when the
          // policy actually allows it rather than loaded and then discarded.
          record.roles = await this.userRoles.namesFor(user.id);
          break;
      }
    }

    return record;
  }

  /**
   * §1.5: who looked at whom, and how it ended. Never the profile contents —
   * an audit trail that copies the data it is auditing doubles the number of
   * places that data has to be protected.
   */
  private audit(
    input: GetUserProfileRequest,
    outcome: 'ok' | 'forbidden' | 'not_found',
    audience: ProfileAudience,
    reason?: string,
  ): void {
    const entry = {
      event: 'users.profile.read',
      viewerUserId: input.viewerUserId,
      targetUserId: input.targetUserId,
      audience,
      outcome,
      reason,
    };

    if (outcome === 'ok') {
      this.logger.log(entry);
    } else {
      this.logger.warn(entry);
    }
  }
}
