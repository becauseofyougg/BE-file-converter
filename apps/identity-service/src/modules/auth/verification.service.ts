import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { VerificationToken } from '@prisma-clients/identity';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  VERIFICATION_TOKEN_TYPES,
  type ConfirmationMethod,
  type VerificationTokenType,
} from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { AuthSettingsService } from './auth-settings.service';

export type { VerificationToken };

/** docs/REGISTRATION.md §5.1 */
export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_INTERVAL_MS = 60 * 1000;
export const MAX_RESENDS_PER_HOUR = 5;

/** docs/REGISTRATION.md §5.2 — longer, because entropy is what protects it. */
export const LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const LINK_BYTES = 32;

/**
 * How long a magic link lives, per purpose.
 *
 * A registration link is often clicked hours later from a different device, so
 * 24 h; a login link is answered immediately, and a live one is a standing
 * invitation to take over the session it belongs to — docs/AUTHENTICATION.md
 * §1.3.2 sets it at 10 minutes for that reason.
 */
const LINK_TTL_BY_TYPE: Record<VerificationTokenType, number> = {
  [VERIFICATION_TOKEN_TYPES.EMAIL_VERIFICATION]: LINK_TTL_MS,
  [VERIFICATION_TOKEN_TYPES.LOGIN_CONFIRMATION]: 10 * 60 * 1000,
  [VERIFICATION_TOKEN_TYPES.PASSWORD_RESET]: 60 * 60 * 1000,
};

export interface IssuedChallenge {
  challengeId: string;
  /** The value that goes in the email. Never stored, never logged. */
  secret: string;
  method: ConfirmationMethod;
  expiresAt: Date;
}

/**
 * Owns the lifecycle of a confirmation challenge: issuing it, rotating it on
 * resend, and consuming it exactly once.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
    private readonly settings: AuthSettingsService,
  ) {}

  private get db() {
    return this.txHost.tx;
  }

  /**
   * Issues the first challenge for a user and type. Any earlier live challenge
   * of the same type is consumed first, so a user never holds two valid codes
   * — and the partial unique index makes that a database guarantee.
   */
  async issue(
    userId: string,
    type: VerificationTokenType = VERIFICATION_TOKEN_TYPES.EMAIL_VERIFICATION,
  ): Promise<IssuedChallenge> {
    await this.invalidateLive(userId, type);

    const method = this.settings.confirmationMethod();
    const { secret, expiresAt } = this.generate(method, type);

    const token = await this.db.verificationToken.create({
      data: {
        userId,
        type,
        tokenHash: hashSecret(secret),
        method,
        expiresAt,
        usedAt: null,
        attempts: 0,
        resendCount: 0,
        lastSentAt: new Date(),
      },
    });

    return { challengeId: token.challengeId, secret, method, expiresAt };
  }

  /**
   * Rotates the secret of an existing challenge, keeping its `challengeId` so
   * the client's handle stays valid.
   *
   * Resetting `attempts` here is safe because the resend limits bound it: at 5
   * resends an hour and 5 guesses each, an attacker gets 25 tries an hour at a
   * one-in-a-million code. Opening a *new* challenge instead would either
   * strand the client's handle or need the response to leak a fresh one.
   */
  async rotate(token: VerificationToken): Promise<IssuedChallenge> {
    this.assertResendAllowed(token);

    const method = this.settings.confirmationMethod();
    const { secret, expiresAt } = this.generate(
      method,
      token.type as VerificationTokenType,
    );

    await this.db.verificationToken.update({
      where: { id: token.id },
      data: {
        tokenHash: hashSecret(secret),
        method,
        expiresAt,
        usedAt: null,
        attempts: 0,
        resendCount: this.withinResendWindow(token) ? token.resendCount + 1 : 1,
        lastSentAt: new Date(),
      },
    });

    return { challengeId: token.challengeId, secret, method, expiresAt };
  }

  findLiveByChallengeId(
    challengeId: string,
  ): Promise<VerificationToken | null> {
    return this.db.verificationToken.findFirst({
      where: { challengeId, usedAt: null },
    });
  }

  findLiveByUser(
    userId: string,
    type: VerificationTokenType = VERIFICATION_TOKEN_TYPES.EMAIL_VERIFICATION,
  ): Promise<VerificationToken | null> {
    return this.db.verificationToken.findFirst({
      where: { userId, type, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * A magic link arrives as the secret alone, with no challenge handle — the
   * hash is the lookup key. Safe because the token carries 256 bits.
   */
  findLiveByRawToken(rawToken: string): Promise<VerificationToken | null> {
    return this.db.verificationToken.findFirst({
      where: { tokenHash: hashSecret(rawToken), usedAt: null },
    });
  }

  /**
   * Checks a submitted secret against a challenge and consumes it on success.
   *
   * The `updateMany ... where usedAt: null` is what makes consumption atomic:
   * two requests arriving with the same valid code both pass the comparison,
   * and only the one whose update reports a changed row wins. `update` would
   * not do — it matches on the id alone and would happily succeed twice.
   */
  async consume(
    token: VerificationToken,
    submitted: string,
  ): Promise<VerificationToken> {
    if (token.usedAt !== null) {
      throw new AppError(
        ERROR_CODES.CONFIRMATION_INVALID,
        'Confirmation is invalid',
        400,
      );
    }

    if (token.expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        ERROR_CODES.CONFIRMATION_EXPIRED,
        'Confirmation has expired, request a new one',
        410,
      );
    }

    if (token.attempts >= MAX_ATTEMPTS) {
      throw new AppError(
        ERROR_CODES.CONFIRMATION_ATTEMPTS_EXCEEDED,
        'Too many incorrect attempts, request a new code',
        429,
      );
    }

    if (!constantTimeEquals(hashSecret(submitted), token.tokenHash)) {
      const attempts = token.attempts + 1;

      await this.db.verificationToken.update({
        where: { id: token.id },
        data: { attempts: { increment: 1 } },
      });

      this.logger.warn({
        event: 'auth.verification.failed',
        userId: token.userId,
        reason: 'invalid',
        attempts,
      });

      throw attempts >= MAX_ATTEMPTS
        ? new AppError(
            ERROR_CODES.CONFIRMATION_ATTEMPTS_EXCEEDED,
            'Too many incorrect attempts, request a new code',
            429,
          )
        : new AppError(
            ERROR_CODES.CONFIRMATION_INVALID,
            'Confirmation is invalid',
            400,
          );
    }

    const result = await this.db.verificationToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    if (result.count === 0) {
      throw new AppError(
        ERROR_CODES.CONFIRMATION_INVALID,
        'Confirmation is invalid',
        400,
      );
    }

    return token;
  }

  assertResendAllowed(token: VerificationToken): void {
    const sinceLast = Date.now() - token.lastSentAt.getTime();

    if (sinceLast < RESEND_INTERVAL_MS) {
      throw new AppError(
        ERROR_CODES.RESEND_TOO_SOON,
        'A code was just sent, please wait before requesting another',
        429,
        {
          retryAfterSeconds: Math.ceil((RESEND_INTERVAL_MS - sinceLast) / 1000),
        },
      );
    }

    if (
      this.withinResendWindow(token) &&
      token.resendCount >= MAX_RESENDS_PER_HOUR
    ) {
      throw new AppError(
        ERROR_CODES.RESEND_TOO_SOON,
        'Too many codes requested, please try again later',
        429,
        { retryAfterSeconds: 3600 },
      );
    }
  }

  /** Expired or spent tokens, whoever they belonged to. */
  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.db.verificationToken.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });

    return result.count;
  }

  private async invalidateLive(
    userId: string,
    type: VerificationTokenType,
  ): Promise<void> {
    await this.db.verificationToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: new Date() },
    });
  }

  private withinResendWindow(token: VerificationToken): boolean {
    return Date.now() - token.lastSentAt.getTime() < 60 * 60 * 1000;
  }

  private generate(
    method: ConfirmationMethod,
    type: VerificationTokenType,
  ): {
    secret: string;
    expiresAt: Date;
  } {
    return method === 'link'
      ? {
          secret: randomBytes(LINK_BYTES).toString('base64url'),
          expiresAt: new Date(Date.now() + LINK_TTL_BY_TYPE[type]),
        }
      : {
          secret: generateOtp(),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
        };
  }
}

/**
 * `crypto.randomInt`, never `Math.random`: the latter is seeded predictably
 * and its output is reconstructable from a handful of samples, which for a
 * six-digit code means an attacker can compute the next one.
 */
export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

/**
 * SHA-256 is the right choice here and argon2 is not: these secrets are
 * high-entropy and short-lived, so there is nothing to brute-force offline,
 * and the verification path must stay cheap enough that it cannot be turned
 * into a CPU-exhaustion vector.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  // timingSafeEqual throws on a length mismatch, which would itself leak.
  // Both sides are fixed-width hex digests, so this only guards corruption.
  return left.length === right.length && timingSafeEqual(left, right);
}
