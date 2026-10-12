import { ConfigService } from '@core/config/config.service';
import type { StorageResolver } from '@storage/storage-resolver';
import type { ConversionConfig } from '../../config/conversion.config';
import type { PrismaService } from '../../database/prisma.service';
import { HistoryRetentionJob } from './history-retention.job';

describe('HistoryRetentionJob', () => {
  const NOW = new Date('2026-10-12T03:30:00.000Z');
  const CUTOFF = new Date('2026-07-14T03:30:00.000Z');

  let findMany: jest.Mock;
  let deleteMany: jest.Mock;
  let storageDelete: jest.Mock;
  let job: HistoryRetentionJob;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    deleteMany = jest
      .fn()
      .mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve({ count: where.id.in.length }),
      );
    storageDelete = jest.fn().mockResolvedValue(undefined);

    job = new HistoryRetentionJob(
      {
        conversionOperation: { findMany, deleteMany },
      } as unknown as PrismaService,
      {
        forDriver: () => ({ delete: storageDelete }),
      } as unknown as StorageResolver,
      {
        getNumber: () => 90,
      } as unknown as ConfigService<ConversionConfig>,
    );

    jest.spyOn(job['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(job['logger'], 'warn').mockImplementation(() => undefined);
  });

  const rows = (count: number, withResult = false) =>
    Array.from({ length: count }, (_, index) => ({
      id: `op-${index}`,
      resultKey: withResult ? `u/op-${index}.json` : null,
      storageDriver: 'local',
    }));

  it('deletes finished history older than the retention period, oldest first', async () => {
    findMany.mockResolvedValueOnce(rows(2));

    await job.run(NOW);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: CUTOFF },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      select: { id: true, resultKey: true, storageDriver: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['op-0', 'op-1'] } },
    });
    expect(job['logger'].log).toHaveBeenCalledWith({
      event: 'conversion.history.retention',
      retentionDays: 90,
      removed: 2,
      kept: 0,
    });
  });

  it('deletes a saved result with its row, the file first', async () => {
    findMany.mockResolvedValueOnce(rows(1, true));

    await job.run(NOW);

    expect(storageDelete).toHaveBeenCalledWith('results', 'u/op-0.json');
    expect(storageDelete.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMany.mock.invocationCallOrder[0],
    );
  });

  it('keeps a row whose file it could not delete, for the next run', async () => {
    findMany.mockResolvedValueOnce([...rows(1, true), ...rows(2).slice(1)]);
    storageDelete.mockRejectedValue(new Error('storage down'));

    await job.run(NOW);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['op-1'] } },
    });
    expect(job['logger'].warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'conversion.history.retention_failed' }),
    );
  });

  it('works through a backlog in batches, and stops when it is done', async () => {
    findMany
      .mockResolvedValueOnce(rows(500))
      .mockResolvedValueOnce(rows(500))
      .mockResolvedValueOnce(rows(3));

    await job.run(NOW);

    expect(findMany).toHaveBeenCalledTimes(3);
    expect(job['logger'].log).toHaveBeenCalledWith(
      expect.objectContaining({ removed: 1003 }),
    );
  });

  it('stops rather than loop when nothing in a batch could be deleted', async () => {
    findMany.mockResolvedValue(rows(500, true));
    storageDelete.mockRejectedValue(new Error('storage down'));

    await job.run(NOW);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('bounds one run however large the backlog', async () => {
    findMany.mockResolvedValue(rows(500));

    await job.run(NOW);

    expect(findMany).toHaveBeenCalledTimes(20);
  });

  it('is quiet when there is nothing to do', async () => {
    await job.run(NOW);

    expect(job['logger'].log).not.toHaveBeenCalled();
  });
});
