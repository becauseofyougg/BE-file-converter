import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  DOMAIN_EVENTS,
  type LoginConfirmationRequestedPayload,
} from '@contracts/events/domain.events';
import {
  VERIFICATION_TOKEN_TYPES,
  type ConfirmLoginResponse,
  type LoginResponse,
} from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import { OutboxService } from '../outbox/outbox.service';
import { UserRolesService } from '../rbac/user-roles.service';
import { TokensService, type SessionContext } from '../tokens/tokens.service';
import {
  UsersService,
  isDeleted,
  isEmailVerified,
  normalizeEmail,
  type SafeUser,
} from '../users/users.service';
import { AuthSettingsService } from './auth-settings.service';
import { PasswordService } from './password.service';
import { VerificationService } from './verification.service';

/**
 * docs/AUTHENTICATION.md §1.4 — the defaults, overridable per deployment
 * through `LOGIN_MAX_FAILED_ATTEMPTS` and `LOGIN_LOCKOUT_MINUTES`.
 */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface LoginInput {
  email: string;
  password: string;
  correlationId: string;
  session?: SessionContext;
}

export interface ConfirmLoginInput {
  challengeId?: string;
  code?: string;
  token?: string;
  correlationId: string;
  session?: SessionContext;
}

@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly verification: VerificationService,
    private readonly tokens: TokensService,
    private readonly outbox: OutboxService,
    private readonly settings: AuthSettingsService,
    private readonly userRoles: UserRolesService,
  ) {}

  /**
   * docs/AUTHENTICATION.md §1.2.
   *
   * Every refusal before the password check still spends a verification's
   * worth of CPU, and every refusal answers with the same
   * `INVALID_CREDENTIALS`. An unknown address, a wrong password and an
   * unverified account must be indistinguishable to someone probing — except
   * for the two cases below, which are deliberately *not* hidden.
   */
  @Transactional()
  async login(input: LoginInput): Promise<LoginResponse> {
    const email = normalizeEmail(input.email);
    const user = await this.users.findByEmail(email);

    // An erased account cannot be reached by its old address anyway — the
    // column was overwritten — but the check is explicit so the behaviour does
    // not rest on that one detail. It is folded into the same refusal as an
    // unknown address, and burns the same time, because "this account was
    // deleted" is exactly the kind of thing §3 says not to disclose.
    if (!user || isDeleted(user)) {
      await this.passwords.burnVerificationTime();
      this.logFailure(user ? 'account_deleted' : 'unknown_account', user?.id);

      throw invalidCredentials();
    }

    // Told plainly, unlike the rest. Someone locked out needs to know to wait
    // rather than keep guessing, and the lock is only reachable by having
    // already guessed at this address five times — it reveals nothing that the
    // attempts themselves did not.
    this.assertNotLocked(user);

    const correct = await this.passwords.verify(
      user.passwordHash,
      input.password,
    );

    if (!correct) {
      await this.registerFailure(user);
      this.logFailure('bad_password', user.id);

      throw invalidCredentials();
    }

    // Also told plainly: the account provably belongs to whoever just proved
    // the password, so there is nobody left to hide it from, and "your address
    // is not confirmed" is the only message that leads anywhere.
    if (!isEmailVerified(user)) {
      await this.users.resetLoginFailures(user.id);
      this.logFailure('email_not_verified', user.id);

      throw new AppError(
        ERROR_CODES.EMAIL_NOT_VERIFIED,
        'Confirm your email address before signing in',
        403,
      );
    }

    if (!this.settings.confirmLogin()) {
      // The counter is cleared as part of issuing the session, in the same
      // statement that records the login — one write rather than two.
      return {
        status: 'authenticated',
        userId: user.id,
        tokens: await this.issueSession(user),
      };
    }

    // The password was right, so the brute-force counter has done its job even
    // though the login is not finished. Clearing it here rather than at
    // confirmation means a user who never finishes is not left part-way to a
    // lockout by a correct password.
    await this.users.resetLoginFailures(user.id);

    return this.requireConfirmation(user, input);
  }

  /**
   * docs/AUTHENTICATION.md §1.3. Accepts an OTP quoted against the challenge
   * handle, or a bare magic-link token.
   */
  @Transactional()
  async confirmLogin(input: ConfirmLoginInput): Promise<ConfirmLoginResponse> {
    const token = input.token
      ? await this.verification.findLiveByRawToken(input.token)
      : input.challengeId
        ? await this.verification.findLiveByChallengeId(input.challengeId)
        : null;

    // The type check matters: without it an email-verification code would
    // complete a login, turning a weaker challenge into a session.
    if (!token || token.type !== VERIFICATION_TOKEN_TYPES.LOGIN_CONFIRMATION) {
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
      throw new AppError(
        ERROR_CODES.CONFIRMATION_INVALID,
        'Confirmation is invalid',
        400,
      );
    }

    this.assertNotLocked(user);

    this.logger.log({ event: 'auth.login.confirmed', userId: user.id });

    return {
      status: 'authenticated',
      userId: user.id,
      // The session belongs to whoever completed the challenge: a link opened
      // on a phone signs the phone in.
      tokens: await this.issueSession(user),
    };
  }

  /**
   * A second code for a login already waiting on one. Reuses the challenge and
   * its resend limits, so this cannot be turned into a mail cannon.
   */
  @Transactional()
  async resendConfirmation(
    challengeId: string,
    correlationId: string,
  ): Promise<{ status: 'accepted' }> {
    const token = await this.verification.findLiveByChallengeId(challengeId);

    if (!token || token.type !== VERIFICATION_TOKEN_TYPES.LOGIN_CONFIRMATION) {
      return { status: 'accepted' };
    }

    const user = await this.users.findById(token.userId);

    if (!user) {
      return { status: 'accepted' };
    }

    const challenge = await this.verification.rotate(token);

    await this.outbox.publish<LoginConfirmationRequestedPayload>(
      DOMAIN_EVENTS.USER_LOGIN_CONFIRMATION_REQUESTED,
      {
        userId: user.id,
        email: user.email,
        method: challenge.method,
        secret: challenge.secret,
        expiresAt: challenge.expiresAt.toISOString(),
      },
      correlationId,
    );

    this.logger.log({
      event: 'auth.login.confirmation_resent',
      userId: user.id,
      method: challenge.method,
    });

    return { status: 'accepted' };
  }

  private async requireConfirmation(
    user: SafeUser,
    input: LoginInput,
  ): Promise<LoginResponse> {
    const challenge = await this.verification.issue(
      user.id,
      VERIFICATION_TOKEN_TYPES.LOGIN_CONFIRMATION,
    );

    await this.outbox.publish<LoginConfirmationRequestedPayload>(
      DOMAIN_EVENTS.USER_LOGIN_CONFIRMATION_REQUESTED,
      {
        userId: user.id,
        email: user.email,
        method: challenge.method,
        secret: challenge.secret,
        expiresAt: challenge.expiresAt.toISOString(),
        // Shown in the mail, so the owner can recognise a sign-in that is not
        // theirs — the main thing this second factor is good for.
        userAgent: input.session?.userAgent,
        ip: input.session?.ip,
      },
      input.correlationId,
    );

    this.logger.log({
      event: 'auth.login.confirmation_required',
      userId: user.id,
      method: challenge.method,
    });

    return {
      status: 'confirmation_required',
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  private async issueSession(user: SafeUser) {
    // Recorded here rather than after the password check, because a login
    // waiting on an emailed confirmation has not happened yet. This is the one
    // place a session actually comes into existence, and the same statement
    // clears the brute-force counter.
    await this.users.recordSuccessfulLogin(user.id);

    const roles = await this.userRoles.namesFor(user.id);

    this.logger.log({
      event: 'auth.login.success',
      userId: user.id,
      roles,
    });

    return this.tokens.issuePair(user, roles);
  }

  private assertNotLocked(user: SafeUser): void {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const retryAfterSeconds = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 1000,
      );

      this.logger.warn({
        event: 'auth.login.locked',
        userId: user.id,
        retryAfterSeconds,
      });

      throw new AppError(
        ERROR_CODES.ACCOUNT_LOCKED,
        'Too many failed attempts; this account is temporarily locked',
        429,
        { retryAfterSeconds },
      );
    }
  }

  /**
   * A fixed window rather than an exponential backoff: the counter resets on
   * any success, so an attacker gets five guesses per fifteen minutes however
   * long they keep at it, while a legitimate user who mistypes twice and then
   * succeeds is never slowed down at all.
   */
  private async registerFailure(user: SafeUser): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;

    if (attempts >= this.settings.maxFailedLoginAttempts()) {
      await this.users.lockLogin(
        user.id,
        new Date(Date.now() + this.settings.loginLockoutMs()),
      );

      this.logger.warn({
        event: 'auth.login.lockout_applied',
        userId: user.id,
        attempts,
      });

      return;
    }

    await this.users.recordLoginFailure(user.id);
  }

  private logFailure(reason: string, userId?: string): void {
    this.logger.warn({ event: 'auth.login.failed', reason, userId });
  }
}

/**
 * One message and one code for every pre-password refusal, so the response
 * body cannot be used to tell an unknown address from a wrong password.
 */
function invalidCredentials(): AppError {
  return new AppError(
    ERROR_CODES.INVALID_CREDENTIALS,
    'Invalid email or password',
    401,
  );
}
