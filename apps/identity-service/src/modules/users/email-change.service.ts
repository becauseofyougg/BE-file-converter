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
import { VerificationService } from '../auth/verification.service';
import { OutboxService } from '../outbox/outbox.service';
import { UsersService, normalizeEmail } from './users.service';

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

    if (!user) {
      throw new AppError(ERROR_CODES.USER_NOT_FOUND, 'User not found', 404);
    }

    const newEmail = normalizeEmail(input.newEmail);

    if (newEmail === user.email) {
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
    await this.assertEmailFree(newEmail, user.id);

    const challenge = await this.verification.issue(
      user.id,
      VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE,
      newEmail,
    );

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

    // The type check matters as much as it does at login: without it an
    // email-verification code — a weaker challenge with a day-long link — would
    // move the account to whatever address this row happens to name.
    if (
      !token ||
      token.type !== VERIFICATION_TOKEN_TYPES.EMAIL_CHANGE ||
      !token.newEmail ||
      // The path segment has to agree with the challenge. It proves nothing on
      // its own, but a mismatch means the client is confused about which
      // account it is changing, and applying it anyway would be worse.
      token.userId !== input.targetUserId
    ) {
      throw invalidConfirmation();
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

    const user = await this.users.findById(token.userId);

    if (!user) {
      throw invalidConfirmation();
    }

    // Re-checked after consumption, not only at initiation: somebody else may
    // have registered or claimed the address in the ten minutes since. The
    // unique index is the real guarantee; this turns it into a 409.
    await this.assertEmailFree(token.newEmail, user.id);

    const previousEmail = user.email;
    const updated = await this.users.changeEmail(user.id, token.newEmail);

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

  private async assertEmailFree(email: string, userId: string): Promise<void> {
    if (await this.users.isEmailTaken(email, userId)) {
      throw new AppError(
        ERROR_CODES.EMAIL_IN_USE,
        'That email address is already in use',
        409,
      );
    }
  }

  /**
   * §1.5. The address being claimed is *not* logged: it is the personal datum
   * the whole exchange is about, and the challenge row already holds it for as
   * long as anyone needs it.
   */
  private audit(
    input: StartEmailChangeRequest,
    outcome: 'started' | 'forbidden',
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

function invalidConfirmation(): AppError {
  return new AppError(
    ERROR_CODES.CONFIRMATION_INVALID,
    'Confirmation is invalid',
    400,
  );
}
