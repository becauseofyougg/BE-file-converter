import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { UsersService } from '../users/users.service';
import { VerificationService } from './verification.service';

/** docs/REGISTRATION.md §7. */
export const UNVERIFIED_RETENTION_DAYS = 7;

/**
 * Deletes accounts that were never confirmed, and the spent or expired tokens
 * of those that were.
 *
 * Without this, a mistyped address holds an email hostage forever: the owner
 * of the real address can never register it, and the `409` they receive is not
 * something they can resolve themselves. Seven days is long enough that a user
 * confirming late is not surprised, and short enough that the table does not
 * fill with abandoned rows.
 */
@Injectable()
export class VerificationCleanupJob {
  private readonly logger = new Logger(VerificationCleanupJob.name);

  constructor(
    private readonly users: UsersService,
    private readonly verification: VerificationService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async run(): Promise<void> {
    const now = Date.now();

    // Cascades to the account's verification and refresh tokens.
    const users = await this.users.deleteUnverifiedBefore(
      new Date(now - UNVERIFIED_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );

    // Everything already past its expiry, whoever it belonged to.
    const tokens = await this.verification.deleteExpiredBefore(new Date(now));

    this.logger.log({
      event: 'auth.verification.cleanup',
      unverifiedUsersRemoved: users,
      expiredTokensRemoved: tokens,
    });
  }
}
