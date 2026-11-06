import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  DOMAIN_EVENTS,
  type EmailChangedPayload,
} from '@contracts/events/domain.events';
import {
  PROFILE_AUDIENCES,
  PROFILE_PATCH_POLICY,
  PROFILE_UPDATE_PERMISSION,
  type ProfileAudience,
  type UpdateUserProfileRequest,
  type UserPatch,
  type UserProfileRecord,
} from '@contracts/messages/users.messages';
import { AppError } from '@core/errors/app-error';
import { orConflict } from '../../database/prisma-errors';
import { OutboxService } from '../outbox/outbox.service';
import { RbacConfigService } from '../rbac/rbac-config.service';
import { ProfileService } from './profile.service';
import { UsersService, isDeleted } from './users.service';

/**
 * `PATCH /users/:userId` — docs/PROFILE-UPDATE.md §3.
 *
 * Mirrors the read path: the same self-or-permission split, decided here rather
 * than by a route decorator because it depends on who the target turns out to
 * be. The permission is `users@update` rather than `users@read`, so a role may
 * be given one without the other.
 */
@Injectable()
export class ProfileUpdateService {
  private readonly logger = new Logger(ProfileUpdateService.name);

  constructor(
    private readonly users: UsersService,
    private readonly profiles: ProfileService,
    private readonly rbac: RbacConfigService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * One transaction, as §1.6 asks: the row, and — when an administrator moves
   * an address — the notice to the address being left behind. Publishing that
   * through the outbox rather than inline is what keeps a rolled-back change
   * from announcing itself.
   */
  @Transactional()
  async updateProfile(
    input: UpdateUserProfileRequest,
  ): Promise<UserProfileRecord> {
    const audience = await this.audienceFor(input);

    // Before the lookup, exactly as the read path does it: a refusal must not
    // depend on whether the id exists, or it becomes a way to discover that.
    this.assertWritable(input, audience);

    const user = await this.users.findById(input.targetUserId);

    if (!user || isDeleted(user)) {
      this.audit(input, 'not_found', audience);

      throw new AppError(ERROR_CODES.USER_NOT_FOUND, 'User not found', 404);
    }

    if (
      input.patch.email !== undefined &&
      (await this.users.isEmailTaken(input.patch.email, user.id))
    ) {
      this.audit(input, 'email_in_use', audience);

      throw emailInUse();
    }

    const previousEmail = user.email;
    // The check above handles the ordinary case; the citext unique index
    // catches two writes racing past it together, which would otherwise
    // surface as a 500.
    const updated = await orConflict(
      this.users.update(user.id, normalizePatch(input.patch)),
      () => {
        this.audit(input, 'email_in_use', audience);

        return emailInUse();
      },
    );

    if (input.patch.email !== undefined && updated.email !== previousEmail) {
      // To the address that just lost the account. It is the only way its owner
      // finds out, and an administrator moving an address is precisely the
      // action worth telling them about.
      await this.outbox.publish<EmailChangedPayload>(
        DOMAIN_EVENTS.USER_EMAIL_CHANGED,
        {
          userId: user.id,
          previousEmail,
          newEmail: updated.email,
          actorUserId: input.viewerUserId,
        },
        input.correlationId ?? user.id,
      );
    }

    this.audit(input, 'ok', audience);

    return this.profiles.projectFor(updated, audience);
  }

  private async audienceFor(
    input: UpdateUserProfileRequest,
  ): Promise<ProfileAudience> {
    if (input.targetUserId === input.viewerUserId) {
      return PROFILE_AUDIENCES.SELF;
    }

    const decision = await this.rbac.check(
      input.viewerRoles,
      PROFILE_UPDATE_PERMISSION.resource,
      PROFILE_UPDATE_PERMISSION.action,
    );

    if (!decision.allowed) {
      this.audit(input, 'forbidden', PROFILE_AUDIENCES.OTHER, decision.reason);

      throw new AppError(ERROR_CODES.FORBIDDEN, 'Access denied', 403);
    }

    return PROFILE_AUDIENCES.OTHER;
  }

  /**
   * Default-deny, and **refuse** rather than ignore. Silently dropping a field
   * would leave a client believing a change it can see in its own form actually
   * happened — the worst of the three possible behaviours, because nothing
   * anywhere reveals the discrepancy.
   *
   * Self hitting `email` is the case the requirement singles out, and it gets
   * its own message: the change is possible, just not through this route.
   */
  private assertWritable(
    input: UpdateUserProfileRequest,
    audience: ProfileAudience,
  ): void {
    const allowed = PROFILE_PATCH_POLICY[audience];
    const refused = sentFields(input.patch).filter(
      (field) => !allowed.includes(field as keyof UserPatch),
    );

    if (refused.length === 0) {
      return;
    }

    this.audit(input, 'field_not_writable', audience, undefined, refused);

    const selfEmail =
      audience === PROFILE_AUDIENCES.SELF && refused.includes('email');

    throw new AppError(
      ERROR_CODES.FIELD_NOT_WRITABLE,
      selfEmail
        ? 'Changing your email address needs confirmation; start it at /users/{id}/email-change'
        : 'Some of those fields cannot be changed by this account',
      403,
      { fields: refused },
    );
  }

  /**
   * §1.5: field **names** only, and every outcome — a refusal is as much a
   * result as a success. The values are the thing being protected, and an
   * audit log that copies them doubles the number of places they have to be
   * protected in.
   */
  private audit(
    input: UpdateUserProfileRequest,
    outcome:
      | 'ok'
      | 'forbidden'
      | 'not_found'
      | 'field_not_writable'
      | 'email_in_use',
    audience: ProfileAudience,
    reason?: string,
    refusedFields?: string[],
  ): void {
    const entry = {
      event: 'users.profile.updated',
      actorUserId: input.viewerUserId,
      targetUserId: input.targetUserId,
      fields: sentFields(input.patch),
      refusedFields,
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

/**
 * Trims the name, and treats one that is now empty as a request to clear it.
 *
 * A form that submits `"   "` means "I removed my name", and storing the spaces
 * would leave a profile that renders as blank but is not null — two states that
 * look identical and behave differently. Only fields the caller actually sent
 * are touched, so the distinction a PATCH exists to express survives.
 */
/**
 * The fields the caller actually sent. Not `Object.keys`: the patch arrives as
 * a class-transformed DTO, and with `target: ES2023` every declared property
 * of that class is an own property — set to `undefined` when absent. Counting
 * keys therefore counted `email` on every request, and a Self changing only
 * their name was refused for touching their address. `null` stays: it is how
 * a PATCH says "clear this".
 */
export function sentFields(patch: UserPatch): string[] {
  return Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field);
}

function emailInUse(): AppError {
  return new AppError(
    ERROR_CODES.EMAIL_IN_USE,
    'That email address is already in use',
    409,
  );
}

function normalizePatch(patch: UserPatch): UserPatch {
  if (patch.displayName === undefined) {
    return patch;
  }

  const trimmed = patch.displayName?.trim();

  return { ...patch, displayName: trimmed ? trimmed : null };
}
