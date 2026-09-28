import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  DOMAIN_EVENTS,
  type DeletionRequestedPayload,
  type UserDeletedPayload,
} from '@contracts/events/domain.events';
import { VERIFICATION_TOKEN_TYPES } from '@contracts/messages/identity.messages';
import {
  PROFILE_DELETE_PERMISSION,
  type ConfirmDeletionRequest,
  type ConfirmDeletionResponse,
  type DeleteUserRequest,
  type DeleteUserResponse,
} from '@contracts/messages/users.messages';
import { AppError } from '@core/errors/app-error';
import { VerificationService } from '../auth/verification.service';
import { OutboxService } from '../outbox/outbox.service';
import { RbacConfigService } from '../rbac/rbac-config.service';
import { UsersService, isDeleted, type SafeUser } from './users.service';

/**
 * Erasing an account — docs/ACCOUNT-DELETION.md.
 *
 * Two paths that differ in one respect. An administrator holding `users@delete`
 * erases immediately; a user erasing their own account must first prove their
 * address, because this is the one irreversible thing the API does and a
 * fifteen-minute-old session found on an unlocked laptop should not be enough
 * to do it.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly users: UsersService,
    private readonly verification: VerificationService,
    private readonly rbac: RbacConfigService,
    private readonly outbox: OutboxService,
  ) {}

  @Transactional()
  async requestDeletion(input: DeleteUserRequest): Promise<DeleteUserResponse> {
    const isSelf = input.targetUserId === input.viewerUserId;

    if (!isSelf) {
      await this.assertMayDelete(input);
    }

    // After the permission check and before anything is revealed, exactly as
    // the read and update paths order it: a refusal must not depend on whether
    // the id exists.
    const user = await this.loadLiveUser(input.targetUserId);

    if (!isSelf) {
      await this.erase(user, input.viewerUserId, input.correlationId);
      this.audit(input, 'deleted', 'admin');

      return { status: 'deleted', userId: user.id };
    }

    return this.requireConfirmation(user, input);
  }

  /**
   * Completes a self-erasure. Authenticated, unlike the email-change
   * confirmation — see docs/ACCOUNT-DELETION.md §4 for why the two differ.
   */
  @Transactional()
  async confirmDeletion(
    input: ConfirmDeletionRequest,
  ): Promise<ConfirmDeletionResponse> {
    const token = input.token
      ? await this.verification.findLiveByRawToken(input.token)
      : input.challengeId
        ? await this.verification.findLiveByChallengeId(input.challengeId)
        : null;

    // The type check is the same one the other flows make, and matters most
    // here: without it a login code would erase an account.
    if (
      !token ||
      token.type !== VERIFICATION_TOKEN_TYPES.ACCOUNT_DELETION ||
      token.userId !== input.targetUserId ||
      // Self only, and the session has to belong to the account being erased.
      token.userId !== input.viewerUserId
    ) {
      throw new AppError(
        ERROR_CODES.CONFIRMATION_INVALID,
        'Confirmation is invalid',
        400,
      );
    }

    const submitted = input.token ?? input.code;

    if (!submitted) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'A code or a token is required',
        400,
      );
    }

    await this.verification.consume(token, submitted);

    const user = await this.loadLiveUser(token.userId);

    await this.erase(user, undefined, input.correlationId);

    this.logger.log({
      event: 'users.deletion.completed',
      actorUserId: user.id,
      targetUserId: user.id,
      mode: 'self',
    });

    return { status: 'deleted', userId: user.id };
  }

  /**
   * The erasure itself — §1.3.1 steps 2 and 3, in one transaction.
   *
   * Order matters only in that everything here commits together: a crash
   * halfway would otherwise leave an account with its roles stripped and its
   * data intact, or its data gone and its sessions live.
   */
  private async erase(
    user: SafeUser,
    actorUserId: string | undefined,
    correlationId: string | undefined,
  ): Promise<void> {
    const { email, photoKey } = user;

    // Any code already in flight dies with the account.
    await this.users.invalidateChallenges(user.id);
    await this.users.clearRoles(user.id);

    const erased = await this.users.anonymize(user.id);

    // Published before the transaction closes, through the outbox, so a
    // rollback cannot announce an erasure that did not happen. It carries the
    // address and the photo key *because* both have just been destroyed here —
    // a consumer that went looking for them afterwards would find nothing.
    await this.outbox.publish<UserDeletedPayload>(
      DOMAIN_EVENTS.USER_DELETED,
      {
        userId: user.id,
        email,
        photoKey,
        deletedAt: (erased.deletedAt ?? new Date()).toISOString(),
        actorUserId,
      },
      correlationId ?? user.id,
    );
  }

  private async requireConfirmation(
    user: SafeUser,
    input: DeleteUserRequest,
  ): Promise<DeleteUserResponse> {
    const challenge = await this.verification.issue(
      user.id,
      VERIFICATION_TOKEN_TYPES.ACCOUNT_DELETION,
    );

    await this.outbox.publish<DeletionRequestedPayload>(
      DOMAIN_EVENTS.USER_DELETION_REQUESTED,
      {
        userId: user.id,
        // To the account's own address: the mail *is* the second factor, since
        // somebody who found an unlocked laptop has the session but not the
        // mailbox.
        email: user.email,
        method: challenge.method,
        secret: challenge.secret,
        expiresAt: challenge.expiresAt.toISOString(),
      },
      input.correlationId ?? user.id,
    );

    this.audit(input, 'confirmation_required', 'self', challenge.method);

    return {
      status: 'confirmation_required',
      challengeId: challenge.challengeId,
      method: challenge.method,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  private async assertMayDelete(input: DeleteUserRequest): Promise<void> {
    const decision = await this.rbac.check(
      input.viewerRoles,
      PROFILE_DELETE_PERMISSION.resource,
      PROFILE_DELETE_PERMISSION.action,
    );

    if (!decision.allowed) {
      this.audit(input, 'forbidden', 'admin', undefined, decision.reason);

      throw new AppError(ERROR_CODES.FORBIDDEN, 'Access denied', 403);
    }
  }

  /**
   * An already-erased account is simply not there, which is what makes a
   * repeated call safe (§1.6): the second one changes nothing and answers the
   * same `404` every other route gives for a user that does not exist.
   */
  private async loadLiveUser(userId: string): Promise<SafeUser> {
    const user = await this.users.findById(userId);

    if (!user || isDeleted(user)) {
      throw new AppError(ERROR_CODES.USER_NOT_FOUND, 'User not found', 404);
    }

    return user;
  }

  /**
   * §1.5: who, whom, which mode, what happened. Never a value being erased —
   * an audit trail that copies the personal data it is recording the
   * destruction of would be a strange thing to build.
   */
  private audit(
    input: DeleteUserRequest,
    outcome: 'deleted' | 'confirmation_required' | 'forbidden',
    mode: 'self' | 'admin',
    method?: string,
    reason?: string,
  ): void {
    const entry = {
      event: 'users.deletion.requested',
      actorUserId: input.viewerUserId,
      targetUserId: input.targetUserId,
      mode,
      outcome,
      method,
      denialReason: reason,
      // The caller's stated reason, kept for support. Bounded by the DTO.
      statedReason: input.reason,
    };

    if (outcome === 'forbidden') {
      this.logger.warn(entry);
    } else {
      this.logger.log(entry);
    }
  }
}
