import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  DOMAIN_EVENTS,
  type EmailChangeRequestedPayload,
  type EmailChangedPayload,
} from '@contracts/events/domain.events';
import { VERIFICATION_TOKEN_TYPES } from '@contracts/messages/identity.messages';
import type {
  ConfirmEmailChangeRequest,
  ConfirmEmailChangeResponse,
  StartEmailChangeRequest,
  StartEmailChangeResponse,
} from '@contracts/messages/users.messages';
import { AppError } from '@core/errors/app-error';
import { orConflict } from '../../database/prisma-errors';
import {
  VerificationService,
  type IssuedChallenge,
  type VerificationToken,
} from '../auth/verification.service';
import { OutboxService } from '../outbox/outbox.service';
import { UsersService, isDeleted, normalizeEmail } from './users.service';

/**
 * Moving an account to a new address — docs/PROFILE-UPDATE.md §4.
 *
 * Self-service only. An administrator changes an address through
 * `PATCH /users/:userId` instead, and the split is the whole point: a user must
 * prove the mailbox they are claiming, while an administrator exists to rescue
 * someone who has lost the mailbox they would otherwise have to prove.
 *
 * The challenge machinery is registration's, with `type = 'email_change'`, so
 * the TTL, the attempt cap, the constant-time comparison, the atomic
 * single-use consumption and the resend interval are the same code rather than
 * a second implementation of the same rules.
 */
@Injectable()
export class EmailChangeService {
  private readonly logger = new Logger(EmailChangeService.name);

  constructor(
    private readonly users: UsersService,
    private readonly verification: VerificationService,
    private readonly outbox: OutboxService,
  ) {}

  @Transactional()
  async start(
    input: StartEmailChangeRequest,
  ): Promise<StartEmailChangeResponse> {
    // Self only, and checked here rather than trusted from the edge. There is
    // no permission that opens this route to anyone else: an administrator has
    // the direct path and does not need to impersonate a confirmation.
    if (input.targetUserId !== input.viewerUserId) {
      this.audit(input, 'forbidden');

      throw new AppError(ERROR_CODES.FORBIDDEN, 'Access denied', 403);
    }

    const user = await this.users.findById(input.targetUserId);

    // An erased account still has a live access token for up to fifteen
    // minutes. Let through, it could claim a fresh address and write a real,
    // verified email back onto the anonymised row — undoing the erasure and
    // holding that address hostage from registration.
    if (!user || isDeleted(user)) {
      this.audit(input, 'not_found');

      throw new AppError(ERROR_CODES.USER_NOT_FOUND, 'User not found', 404);
    }

    const newEmail = normalizeEmail(input.newEmail);

    if (newEmail === user.email) {
      this.audit(input, 'same_address');

      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'That is already your email address',
        400,
      );
    }

    // A plain 409, unlike registration's deliberate silence. The difference is
    // that this caller is authenticated: an account probing addresses is
    // traceable and rate-limited, so the enumeration argument is far weaker —
    // and someone who mistypes a colleague's address deserves to be told, not
    // left waiting for a mail that will never arrive.
    if (await this.users.isEmailTaken(newEmail, user.id)) {
      this.audit(input, 'email_in_use');

      throw emailInUse();
    }

    const challenge = await this.issueOrRotate(input, user.id, newEmail);

    await this.outbox.publish<EmailChangeRequestedPayload>(
      DOMAIN_EVENTS.USER_EMAIL_CHANGE_REQUESTED,
      {
        userId: user.id,
        // To the address being claimed, never the current one: the point is to
        // prove that this mailbox is reachable by this user.
        newEmail,
        method: challenge.method,
        secret: challenge.secret,
        expiresAt: challenge.expiresAt.toISOString(),
      },
      input.correlationId ?? user.id,
    );

    this.audit(input, 'started', challenge.method);

    return {
      requiresConfirmation: true,
      challengeId: challenge.challengeId,
      method: challenge.method,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  /**
   * Needs no session: the link is opened in the new mailbox, often on another
   * device. What authorises the change is the secret, which only the holder of
   * that mailbox received, and which the initiating Self already proved a
   * session for — docs/PROFILE-UPDATE.md §4.2.
   */
  @Transactional()
  async confirm(
    input: ConfirmEmailChangeRequest,
  ): Promise<ConfirmEmailChangeResponse> {
    const token = input.token
      ? await this.verification.findLiveByRawToken(input.token)
      : input.challengeId
        ? await this.verification.findLiveByChallengeId(input.challengeId)
        : null;

    const refusal = challengeRefusal(token, input.targetUserId);

    if (!token?.newEmail || refusal) {
      // Under the event `consume` logs its own refusals with, so one query
      // finds every failed confirmation whatever stopped it.
      this.logger.warn({
        event: 'auth.verification.failed',
        type: VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE,
        reason: refusal,
        userId: token?.userId,
        targetUserId: input.targetUserId,
      });

      throw invalidConfirmation();
    }

    const newEmail = token.newEmail;

    const submitted = input.token ?? input.code;

    if (!submitted) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        'A code or a token is required',
        400,
      );
    }

    await this.verification.consume(token, submitted);

    const user = await this.users.findById(token.userId);

    // Erased since the challenge was issued: erasure spends live challenges,
    // but the check is explicit so the guarantee does not rest on that alone.
    if (!user || isDeleted(user)) {
      this.confirmFailed(token.userId, 'account_removed');

      throw invalidConfirmation();
    }

    // Re-checked after consumption, not only at initiation: somebody else may
    // have registered or claimed the address in the ten minutes since.
    if (await this.users.isEmailTaken(newEmail, user.id)) {
      this.confirmFailed(user.id, 'email_in_use');

      throw emailInUse();
    }

    const previousEmail = user.email;
    // The check above handles the ordinary case; the unique index catches two
    // claims racing past it together, which would otherwise surface as a 500.
    const updated = await orConflict(
      this.users.changeEmail(user.id, newEmail),
      () => {
        this.confirmFailed(user.id, 'email_in_use');

        return emailInUse();
      },
    );

    await this.outbox.publish<EmailChangedPayload>(
      DOMAIN_EVENTS.USER_EMAIL_CHANGED,
      { userId: user.id, previousEmail, newEmail: updated.email },
      input.correlationId ?? user.id,
    );

    this.logger.log({
      event: 'users.email_change.confirmed',
      actorUserId: user.id,
      targetUserId: user.id,
      fields: ['email'],
    });

    return { status: 'email_changed', userId: user.id, email: updated.email };
  }

  /**
   * One live challenge per user, and the resend limits apply to starting over
   * as much as to asking again. Issuing a fresh challenge each time reset them:
   * every call mailed a new code, whatever the 60-second interval said, and
   * only the per-IP throttle stood in the way. A pending challenge is rotated
   * instead — onto the new address if it changed — which enforces the interval
   * and keeps the hourly count running.
   */
  private async issueOrRotate(
    input: StartEmailChangeRequest,
    userId: string,
    newEmail: string,
  ): Promise<IssuedChallenge> {
    const live = await this.verification.findLiveByUser(
      userId,
      VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE,
    );

    if (!live) {
      return this.verification.issue(
        userId,
        VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE,
        newEmail,
      );
    }

    try {
      return await this.verification.rotate(live, newEmail);
    } catch (error) {
      if (error instanceof AppError) {
        this.audit(input, 'resend_too_soon');
      }

      throw error;
    }
  }

  private confirmFailed(
    userId: string,
    reason: 'account_removed' | 'email_in_use',
  ): void {
    this.logger.warn({
      event: 'users.email_change.failed',
      actorUserId: userId,
      targetUserId: userId,
      fields: ['email'],
      reason,
    });
  }

  /**
   * §1.5. The address being claimed is *not* logged: it is the personal datum
   * the whole exchange is about, and the challenge row already holds it for as
   * long as anyone needs it.
   */
  private audit(
    input: StartEmailChangeRequest,
    outcome:
      | 'started'
      | 'forbidden'
      | 'not_found'
      | 'same_address'
      | 'email_in_use'
      | 'resend_too_soon',
    method?: string,
  ): void {
    const entry = {
      event: 'users.email_change.requested',
      actorUserId: input.viewerUserId,
      targetUserId: input.targetUserId,
      fields: ['email'],
      outcome,
      method,
    };

    if (outcome === 'started') {
      this.logger.log(entry);
    } else {
      this.logger.warn(entry);
    }
  }
}

/** Why a challenge cannot confirm this change, or `null` when it can. */
function challengeRefusal(
  token: VerificationToken | null,
  targetUserId: string,
): 'unknown_challenge' | 'wrong_type' | 'wrong_owner' | null {
  if (!token) {
    return 'unknown_challenge';
  }

  // The type check matters as much as it does at login: without it an
  // email-verification code — a weaker challenge with a day-long link — would
  // move the account to whatever address this row happens to name.
  if (token.type !== VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE || !token.newEmail) {
    return 'wrong_type';
  }

  // The path segment has to agree with the challenge. It proves nothing on its
  // own, but a mismatch means the client is confused about which account it is
  // changing, and applying it anyway would be worse.
  if (token.userId !== targetUserId) {
    return 'wrong_owner';
  }

  return null;
}

function emailInUse(): AppError {
  return new AppError(
    ERROR_CODES.EMAIL_IN_USE,
    'That email address is already in use',
    409,
  );
}

function invalidConfirmation(): AppError {
  return new AppError(
    ERROR_CODES.CONFIRMATION_INVALID,
    'Confirmation is invalid',
    400,
  );
}
