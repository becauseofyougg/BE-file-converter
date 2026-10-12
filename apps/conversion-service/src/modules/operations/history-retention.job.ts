import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ConfigService } from '@core/config/config.service';
import { StorageResolver } from '@storage/storage-resolver';
import type { ConversionConfig } from '../../config/conversion.config';
import { PrismaService } from '../../database/prisma.service';

/** Rows per batch, and batches per run: a run is bounded however far behind. */
const BATCH = 500;
const MAX_BATCHES = 20;

/**
 * Deletes history older than `HISTORY_RETENTION_DAYS` (90 by default) —
 * docs/TRANSFORMATION-HISTORY.md §6. A saved result goes with its row: the
 * retention period is the promise, for the record and the file alike, and
 * storage does not grow without end.
 *
 * The file first, then the row. A file that cannot be deleted keeps its row,
 * so the next run finds it again; deleting the row first would orphan the
 * file with nothing left that knows where it is.
 *
 * Operations still `PROCESSING` are never touched here; the cleanup job owns
 * those. Several replicas may run this at once — every step is idempotent.
 */
@Injectable()
export class HistoryRetentionJob {
  private readonly logger = new Logger(HistoryRetentionJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageResolver,
    private readonly config: ConfigService<ConversionConfig>,
  ) {}

  @Cron('30 3 * * *')
  async run(now = new Date()): Promise<void> {
    const days = this.config.getNumber('HISTORY_RETENTION_DAYS');
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    let removed = 0;
    let kept = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.conversionOperation.findMany({
        where: {
          createdAt: { lt: cutoff },
          status: { in: ['COMPLETED', 'FAILED'] },
        },
        select: { id: true, resultKey: true, storageDriver: true },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      });

      if (rows.length === 0) {
        break;
      }

      const deletable: string[] = [];

      for (const row of rows) {
        if (await this.deleteResult(row)) {
          deletable.push(row.id);
        } else {
          kept += 1;
        }
      }

      if (deletable.length > 0) {
        const { count } = await this.prisma.conversionOperation.deleteMany({
          where: { id: { in: deletable } },
        });

        removed += count;
      }

      // Every row of this batch failed its file: the next batch would be the
      // same rows. Stop, and let tomorrow's run try again.
      if (deletable.length === 0 || rows.length < BATCH) {
        break;
      }
    }

    if (removed > 0 || kept > 0) {
      this.logger.log({
        event: 'conversion.history.retention',
        retentionDays: days,
        removed,
        kept,
      });
    }
  }

  private async deleteResult(row: {
    id: string;
    resultKey: string | null;
    storageDriver: string;
  }): Promise<boolean> {
    if (row.resultKey === null) {
      return true;
    }

    try {
      await this.resolver
        .forDriver(row.storageDriver)
        .delete('results', row.resultKey);

      return true;
    } catch (error) {
      this.logger.warn({
        event: 'conversion.history.retention_failed',
        operationId: row.id,
        error: (error as Error).message,
      });

      return false;
    }
  }
}
