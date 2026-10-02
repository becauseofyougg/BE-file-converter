import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { StorageResolver } from '@storage/storage-resolver';
import { PrismaService } from '../../database/prisma.service';

/** Rows handled per run, so one run is bounded however far behind it is. */
const BATCH = 100;

/**
 * Past this an operation still marked PROCESSING is not running: the
 * synchronous timeout is far shorter, so the replica died mid-conversion.
 */
export const STALE_AFTER_MS = 10 * 60_000;

/**
 * Housekeeping for the synchronous conversions.
 *
 * - **Unsaved results** past their time are deleted from storage; the row
 *   stays, as history, with its result marked gone.
 * - **Interrupted operations** are marked FAILED, and their upload deleted —
 *   the replica that would have done both is gone.
 *
 * Several replicas may run this at once; every step is idempotent, so the
 * worst case is the same file deleted twice.
 */
@Injectable()
export class ConversionCleanupJob {
  private readonly logger = new Logger(ConversionCleanupJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageResolver,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(now = new Date()): Promise<void> {
    const expired = await this.removeExpiredResults(now);
    const interrupted = await this.failInterrupted(now);

    if (expired > 0 || interrupted > 0) {
      this.logger.log({ event: 'conversion.cleanup', expired, interrupted });
    }
  }

  private async removeExpiredResults(now: Date): Promise<number> {
    const rows = await this.prisma.conversionOperation.findMany({
      where: { resultExpiresAt: { lt: now }, resultKey: { not: null } },
      select: { id: true, resultKey: true, storageDriver: true },
      take: BATCH,
    });

    let removed = 0;

    for (const row of rows) {
      try {
        await this.resolver
          .forDriver(row.storageDriver)
          .delete('results', row.resultKey!);
        await this.prisma.conversionOperation.update({
          where: { id: row.id },
          data: { resultKey: null, resultExpiresAt: null },
        });
        removed += 1;
      } catch (error) {
        // Left for the next run.
        this.logger.warn({
          event: 'conversion.cleanup_failed',
          operationId: row.id,
          error: (error as Error).message,
        });
      }
    }

    return removed;
  }

  private async failInterrupted(now: Date): Promise<number> {
    const rows = await this.prisma.conversionOperation.findMany({
      where: {
        status: 'PROCESSING',
        createdAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) },
      },
      select: { id: true, userId: true, storageDriver: true },
      take: BATCH,
    });

    for (const row of rows) {
      try {
        const storage = this.resolver.forDriver(row.storageDriver);

        await storage.delete('uploads', storage.buildKey(row.userId, row.id));
      } catch (error) {
        this.logger.warn({
          event: 'conversion.cleanup_failed',
          operationId: row.id,
          error: (error as Error).message,
        });
      }
    }

    if (rows.length === 0) {
      return 0;
    }

    const { count } = await this.prisma.conversionOperation.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, status: 'PROCESSING' },
      data: {
        status: 'FAILED',
        errorCode: ERROR_CODES.INTERNAL_ERROR,
        errorMessage: 'The conversion was interrupted',
        finishedAt: now,
      },
    });

    return count;
  }
}
