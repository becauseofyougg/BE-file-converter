import type { PrismaService } from '../../database/prisma.service';
import { OUTBOX_RETENTION_DAYS, OutboxCleanupJob } from './outbox-cleanup.job';
import { MAX_ATTEMPTS } from './outbox.relay';

describe('OutboxCleanupJob', () => {
  const NOW = new Date('2026-09-29T04:00:00.000Z');
  const CUTOFF = new Date(
    NOW.getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  let deleteMany: jest.Mock;
  let job: OutboxCleanupJob;

  beforeEach(() => {
    deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    job = new OutboxCleanupJob({
      outboxMessage: { deleteMany },
    } as unknown as PrismaService);
    jest.spyOn(job['logger'], 'log').mockImplementation(() => undefined);
  });

  const where = () =>
    deleteMany.mock.calls[0][0].where as {
      OR: Array<Record<string, unknown>>;
    };

  it('removes published rows once they are past the retention window', async () => {
    await job.run(NOW);

    expect(where().OR).toContainEqual({ publishedAt: { lt: CUTOFF } });
  });

  /**
   * Dead rows keep their payload for an operator — but not indefinitely: the
   * codes inside expired long ago, and a `user.deleted` address has no
   * business outliving the erasure by more than the window.
   */
  it('removes dead rows after the same window', async () => {
    await job.run(NOW);

    expect(where().OR).toContainEqual({
      publishedAt: null,
      attempts: { gte: MAX_ATTEMPTS },
      occurredAt: { lt: CUTOFF },
    });
  });

  /** The relay still owes the broker these, however long they have waited. */
  it('never touches a row still in flight', async () => {
    await job.run(NOW);

    for (const clause of where().OR) {
      const inFlight = clause.publishedAt === null;

      if (inFlight) {
        expect(clause.attempts).toEqual({ gte: MAX_ATTEMPTS });
      }
    }
    expect(where().OR).toHaveLength(2);
  });

  it('says how many it removed', async () => {
    await job.run(NOW);

    expect(job['logger'].log).toHaveBeenCalledWith({
      event: 'outbox.cleanup',
      removed: 3,
    });
  });

  it('keeps a week', () => {
    expect(OUTBOX_RETENTION_DAYS).toBe(7);
  });

  it('defaults to the current time', async () => {
    await job.run();

    const cutoff = (where().OR[0].publishedAt as { lt: Date }).lt.getTime();

    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(
      OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
  });
});
