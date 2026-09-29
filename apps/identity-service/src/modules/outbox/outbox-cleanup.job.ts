import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../database/prisma.service';
import { MAX_ATTEMPTS } from './outbox.relay';

/**
 * How long a finished outbox row is kept. Long enough to answer "did that
 * event go out, and when" for a support question from last week; short enough
 * that the table stays the size of recent traffic.
 */
export const OUTBOX_RETENTION_DAYS = 7;

/**
 * Removes outbox rows nothing will read again.
 *
 * - **Published** rows are already emptied by the relay; what goes here is the
 *   metadata, once it is too old to be useful.
 * - **Dead** rows — the relay gave up after `MAX_ATTEMPTS` — still hold their
 *   payload, so an operator can see what failed and replay it. They get the
 *   same week. After that the codes inside have long expired, and an address
 *   from a `user.deleted` event has no business outliving the erasure by more.
 *
 * Rows still in flight are never touched, whatever their age: the relay owes
 * the broker those.
 *
 * The base client, as in the relay: this runs on a timer, outside any request,
 * and must not be swept into someone else's transaction.
 */
@Injectable()
export class OutboxCleanupJob {
  private readonly logger = new Logger(OutboxCleanupJob.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async run(now = new Date()): Promise<void> {
    const cutoff = new Date(
      now.getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    const { count } = await this.prisma.outboxMessage.deleteMany({
      where: {
        OR: [
          { publishedAt: { lt: cutoff } },
          {
            publishedAt: null,
            attempts: { gte: MAX_ATTEMPTS },
            occurredAt: { lt: cutoff },
          },
        ],
      },
    });

    this.logger.log({ event: 'outbox.cleanup', removed: count });
  }
}
