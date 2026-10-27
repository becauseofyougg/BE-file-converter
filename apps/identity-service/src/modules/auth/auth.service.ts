import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { isUniqueViolation } from '../../database/prisma-errors';
import { OutboxService } from '../outbox/outbox.service';
import { UserRolesService } from '../rbac/user-roles.service';
import { TOKEN_ISSUER, type TokenIssuer } from '../tokens/token-issuer';
import {
  UsersService,
  isEmailVerified,
  normalizeEmail,
  type SafeUser,
} from '../users/users.service';
import { AuthSettingsService } from './auth-settings.service';
import { PASSWORD_HASHER, type PasswordHasher } from './password-hasher';
import { PasswordPolicy } from './password-policy';
import type { SessionContext } from './session-context';
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
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    private readonly policy: PasswordPolicy,
    private readonly verification: VerificationService,
    @Inject(TOKEN_ISSUER) private readonly tokens: TokenIssuer,
    private readonly outbox: OutboxService,
    private readonly settings: AuthSettingsService,
    private readonly userRoles: UserRolesService,
  ) {}

  /**
   * docs/REGISTRATION.md §4.
   *
   * The password is hashed *before* the existence check and on every path,
   * including the ones that create nothing. Short-circuiting on a duplicate
   * would make the response measurably faster for addresses that exist, and a
   * timing oracle defeats the neutral wording everywhere else in this method.
   * It is hashed outside the transaction, too: ~100 ms of argon2 has no
   * business holding a pooled connection open.
   */
  async register(input: RegisterInput): Promise<RegisterResponse> {
    const email = normalizeEmail(input.email);

    this.logger.log({ event: 'auth.register.attempt' });
    this.assertPasswordPolicy(input.password);

    const passwordHash = await this.passwords.hash(input.password);

    try {
      return await this.createAccount(email, passwordHash, input);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // Two requests for one address both passed the existence check and the
      // unique index stopped the second insert — docs/REGISTRATION.md §8. The
      // winner has committed by the time Postgres reports the violation, so a
      // second pass finds its row and answers exactly as a sequential
      // duplicate would, instead of the 500 the raw error becomes. It has to
      // be a fresh transaction: the failed insert aborted the first one.
      this.logger.warn({ event: 'auth.register.concurrent_duplicate' });

      return this.createAccount(email, passwordHash, input);
    }
  }

  @Transactional()
  private async createAccount(
    email: string,
    passwordHash: string,
    input: RegisterInput,
  ): Promise<RegisterResponse> {
    const confirmationRequired = this.settings.confirmRegistration();
    const existing = await this.users.findByEmail(email);

    if (existing) {
      return this.handleDuplicate(existing, confirmationRequired, input);
    }

    const user = await this.users.create({
      email,
      passwordHash,
      emailVerified: !confirmationRequired,
    });

    // Inside the same transaction as the account: a user row with no roles can
    // do nothing at all, so the two must never be separable.
    const roles = await this.userRoles.assignDefault(user.id);

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
        tokens: await this.tokens.issuePair(user, roles),
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
      // No userId to attach — that is the point: the handle or link matched
      // nothing, which is what a guess looks like.
      this.logger.warn({
        event: 'auth.verification.failed',
        reason: 'unknown_challenge',
      });

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
      this.logger.warn({
        event: 'auth.verification.failed',
        userId: token.userId,
        reason: 'account_removed',
      });

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
      tokens: await this.tokens.issuePair(
        user,
        await this.userRoles.namesFor(user.id),
      ),
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

    // Asked by email, the cooldown refusal would itself be the answer to "does
    // this address have a pending account?" — an unknown address never hits
    // it, so two calls in a row would tell the two apart. Only a caller quoting
    // the challenge handle, and so already holding the proof, is told to wait.
    if (!input.challengeId) {
      await this.resendQuietly(token, user, input.correlationId);

      return { status: 'accepted' };
    }

    const challenge = await this.verification.rotate(token);

    await this.announce(
      user,
      challenge,
      DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
      input.correlationId,
    );

    return { status: 'accepted' };
  }

  /** The policy refusal is the one registration failure not logged elsewhere. */
  private assertPasswordPolicy(password: string): void {
    try {
      this.policy.assertMeetsPolicy(password);
    } catch (error) {
      this.logger.warn({
        event: 'auth.register.rejected',
        reason: error instanceof AppError ? error.code : 'unknown',
      });

      throw error;
    }
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
    existing: SafeUser,
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
   * A resend asked for by email — re-registration, or the resend endpoint
   * given an address rather than a challenge handle. Hitting the resend limits
   * must not surface as an error here — that would turn the refusal itself
   * into proof the address exists — so the existing challenge is handed back
   * unchanged and no second mail goes out.
   */
  private async resendQuietly(
    live: VerificationToken,
    user: SafeUser,
    correlationId: string,
  ): Promise<IssuedChallenge> {
    try {
      this.verification.assertResendAllowed(live);
    } catch {
      this.logger.log({
        event: 'auth.verification.resend_suppressed',
        userId: user.id,
      });

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
    user: SafeUser,
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
   *
   * Every path that mails a code or link comes through here, so this is where
   * the send is logged — the method, never the secret.
   */
  private async announce(
    user: SafeUser,
    challenge: IssuedChallenge,
    eventName:
      | typeof DOMAIN_EVENTS.USER_REGISTERED
      | typeof DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
    correlationId: string,
  ): Promise<void> {
    await this.outbox.publish<UserRegisteredPayload>(
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

    this.logger.log({
      event:
        eventName === DOMAIN_EVENTS.USER_REGISTERED
          ? 'auth.verification.sent'
          : 'auth.verification.resent',
      userId: user.id,
      method: challenge.method,
    });
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
