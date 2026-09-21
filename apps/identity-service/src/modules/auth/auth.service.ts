import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  DOMAIN_EVENTS,
  type UserRegisteredPayload,
  type UserRegistrationAttemptedPayload,
  type UserEmailVerifiedPayload,
} from '@contracts/events/domain.events';
import {
  VERIFICATION_TOKEN_TYPES,
  type ConfirmationMethod,
  type RegisterResponse,
  type ResendVerificationResponse,
  type VerifyEmailResponse,
} from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import { OutboxService } from '../outbox/outbox.service';
import { TokensService, type SessionContext } from '../tokens/tokens.service';
import {
  UsersService,
  isEmailVerified,
  normalizeEmail,
  type User,
} from '../users/users.service';
import { AuthSettingsService } from './auth-settings.service';
import { PasswordService } from './password.service';
import {
  VerificationService,
  type IssuedChallenge,
  type VerificationToken,
} from './verification.service';

export interface RegisterInput {
  email: string;
  password: string;
  correlationId: string;
  session?: SessionContext;
}

export interface VerifyEmailInput {
  challengeId?: string;
  code?: string;
  token?: string;
  correlationId: string;
  session?: SessionContext;
}

export interface ResendVerificationInput {
  challengeId?: string;
  email?: string;
  correlationId: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly verification: VerificationService,
    private readonly tokens: TokensService,
    private readonly outbox: OutboxService,
    private readonly settings: AuthSettingsService,
  ) {}

  /**
   * docs/REGISTRATION.md §4.
   *
   * The password is hashed *before* the existence check and on every path,
   * including the ones that create nothing. Short-circuiting on a duplicate
   * would make the response measurably faster for addresses that exist, and a
   * timing oracle defeats the neutral wording everywhere else in this method.
   */
  @Transactional()
  async register(input: RegisterInput): Promise<RegisterResponse> {
    const email = normalizeEmail(input.email);
    const confirmationRequired = this.settings.confirmRegistration();

    this.passwords.assertMeetsPolicy(input.password);

    const passwordHash = await this.passwords.hash(input.password);
    const existing = await this.users.findByEmail(email);

    if (existing) {
      return this.handleDuplicate(existing, confirmationRequired, input);
    }

    const user = await this.users.create({
      email,
      passwordHash,
      emailVerified: !confirmationRequired,
    });

    if (!confirmationRequired) {
      await this.outbox.publish<UserRegisteredPayload>(
        DOMAIN_EVENTS.USER_REGISTERED,
        { userId: user.id, email: user.email },
        input.correlationId,
      );

      this.logger.log({
        event: 'auth.register.success',
        userId: user.id,
        confirmation: false,
      });

      return {
        status: 'registered',
        userId: user.id,
        tokens: await this.tokens.issuePair(user, input.session),
      };
    }

    const challenge = await this.issueAndAnnounce(
      user,
      DOMAIN_EVENTS.USER_REGISTERED,
      input.correlationId,
    );

    this.logger.log({
      event: 'auth.register.success',
      userId: user.id,
      confirmation: true,
      method: challenge.method,
    });

    return {
      status: 'confirmation_required',
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  /**
   * docs/REGISTRATION.md §5.3. Accepts either an OTP quoted against a
   * challenge handle or a bare magic-link token.
   */
  @Transactional()
  async verifyEmail(input: VerifyEmailInput): Promise<VerifyEmailResponse> {
    const token = await this.locateChallenge(input);

    if (!token) {
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

    const user = await this.users.findById(token.userId);

    if (!user) {
      // The cleanup job removed the account between issuing and confirming.
      throw new AppError(
        ERROR_CODES.CONFIRMATION_INVALID,
        'Confirmation is invalid',
        400,
      );
    }

    if (!isEmailVerified(user)) {
      await this.users.markEmailVerified(user.id);
      user.emailVerifiedAt = new Date();

      await this.outbox.publish<UserEmailVerifiedPayload>(
        DOMAIN_EVENTS.USER_EMAIL_VERIFIED,
        { userId: user.id, email: user.email },
        input.correlationId,
      );
    }

    this.logger.log({
      event: 'auth.verification.success',
      userId: user.id,
    });

    return {
      status: 'verified',
      userId: user.id,
      // Signed in on the spot: the user just proved both the password (at
      // registration) and the address, so asking them to type it again buys
      // nothing.
      tokens: await this.tokens.issuePair(user, input.session),
    };
  }

  /**
   * docs/REGISTRATION.md §5.4. The response is identical whether the account
   * exists, is already verified, or never existed — only the rate-limit
   * refusals differ, and those are keyed on a challenge the caller already
   * proved it holds.
   */
  @Transactional()
  async resendVerification(
    input: ResendVerificationInput,
  ): Promise<ResendVerificationResponse> {
    const token = await this.locateResendTarget(input);

    if (!token) {
      this.logger.log({ event: 'auth.verification.resend_noop' });

      return { status: 'accepted' };
    }

    const user = await this.users.findById(token.userId);

    if (!user || isEmailVerified(user)) {
      return { status: 'accepted' };
    }

    const challenge = await this.verification.rotate(token);

    await this.announce(
      user,
      challenge,
      DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
      input.correlationId,
    );

    this.logger.log({
      event: 'auth.verification.resent',
      userId: user.id,
      method: challenge.method,
    });

    return { status: 'accepted' };
  }

  /**
   * An address that is already taken.
   *
   * With confirmation **on** the answer is the same 202 the happy path
   * returns, so the endpoint reveals nothing. An unverified account gets its
   * challenge rotated — someone re-registering after losing the first mail is
   * the common case, and it is the same operation as a resend. A verified one
   * gets a notice mail instead, and the caller receives a challenge handle
   * that matches no row: any code submitted against it fails exactly as a
   * wrong code would.
   *
   * With confirmation **off** no such cover exists — the caller either gets a
   * session or does not — so a plain 409 is the honest answer, and the
   * registration throttle is what makes enumeration expensive.
   */
  private async handleDuplicate(
    existing: User,
    confirmationRequired: boolean,
    input: RegisterInput,
  ): Promise<RegisterResponse> {
    this.logger.warn({
      event: 'auth.register.duplicate_email',
      userId: existing.id,
      verified: isEmailVerified(existing),
    });

    if (!confirmationRequired) {
      throw new AppError(
        ERROR_CODES.EMAIL_ALREADY_REGISTERED,
        'This email is already registered',
        409,
      );
    }

    if (isEmailVerified(existing)) {
      await this.outbox.publish<UserRegistrationAttemptedPayload>(
        DOMAIN_EVENTS.USER_REGISTRATION_ATTEMPTED,
        { userId: existing.id, email: existing.email },
        input.correlationId,
      );

      return {
        status: 'confirmation_required',
        challengeId: randomUUID(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      };
    }

    const live = await this.verification.findLiveByUser(
      existing.id,
      VERIFICATION_TOKEN_TYPES.EMAIL_VERIFICATION,
    );

    // No live challenge, or one that may be resent: either way the caller
    // ends up with a usable handle and the owner with a fresh code.
    const challenge = live
      ? await this.resendQuietly(live, existing, input.correlationId)
      : await this.issueAndAnnounce(
          existing,
          DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
          input.correlationId,
        );

    return {
      status: 'confirmation_required',
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  /**
   * A resend triggered by re-registration rather than by the resend endpoint.
   * Hitting the 60-second limit must not surface as an error here — that would
   * turn the refusal itself into proof the address exists — so the existing
   * challenge is handed back unchanged and no second mail goes out.
   */
  private async resendQuietly(
    live: VerificationToken,
    user: User,
    correlationId: string,
  ): Promise<IssuedChallenge> {
    try {
      this.verification.assertResendAllowed(live);
    } catch {
      return {
        challengeId: live.challengeId,
        secret: '',
        // The column is a varchar, so Prisma types it as `string`; the narrow
        // set lives in the contract, and only this service ever writes it.
        method: live.method as ConfirmationMethod,
        expiresAt: live.expiresAt,
      };
    }

    const challenge = await this.verification.rotate(live);

    await this.announce(
      user,
      challenge,
      DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
      correlationId,
    );

    return challenge;
  }

  private async issueAndAnnounce(
    user: User,
    eventName:
      | typeof DOMAIN_EVENTS.USER_REGISTERED
      | typeof DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
    correlationId: string,
  ): Promise<IssuedChallenge> {
    const challenge = await this.verification.issue(
      user.id,
      VERIFICATION_TOKEN_TYPES.EMAIL_VERIFICATION,
    );

    await this.announce(user, challenge, eventName, correlationId);

    return challenge;
  }

  /**
   * The secret travels to notification-service inside the event, because that
   * is the only service allowed to talk to an SMTP server — and it is written
   * to the outbox in the same transaction as the challenge, so a rolled-back
   * registration cannot produce a mail about a user who does not exist.
   */
  private announce(
    user: User,
    challenge: IssuedChallenge,
    eventName:
      | typeof DOMAIN_EVENTS.USER_REGISTERED
      | typeof DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
    correlationId: string,
  ): Promise<void> {
    return this.outbox.publish<UserRegisteredPayload>(
      eventName,
      {
        userId: user.id,
        email: user.email,
        confirmation: {
          method: challenge.method,
          secret: challenge.secret,
          expiresAt: challenge.expiresAt.toISOString(),
        },
      },
      correlationId,
    );
  }

  private locateChallenge(
    input: VerifyEmailInput,
  ): Promise<VerificationToken | null> {
    if (input.token) {
      return this.verification.findLiveByRawToken(input.token);
    }

    if (input.challengeId) {
      return this.verification.findLiveByChallengeId(input.challengeId);
    }

    return Promise.resolve(null);
  }

  private async locateResendTarget(
    input: ResendVerificationInput,
  ): Promise<VerificationToken | null> {
    if (input.challengeId) {
      return this.verification.findLiveByChallengeId(input.challengeId);
    }

    if (!input.email) {
      return null;
    }

    const user = await this.users.findByEmail(input.email);

    return user
      ? this.verification.findLiveByUser(
          user.id,
          VERIFICATION_TOKEN_TYPES.EMAIL_VERIFICATION,
        )
      : null;
  }
}
