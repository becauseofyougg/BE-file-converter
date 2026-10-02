import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { StorageResolver } from '@storage/storage-resolver';
import type { PrismaService } from '../../database/prisma.service';
import { ConversionCleanupJob, STALE_AFTER_MS } from './conversion-cleanup.job';

describe('ConversionCleanupJob', () => {
  const NOW = new Date('2026-10-02T12:00:00.000Z');

  let findMany: jest.Mock;
  let update: jest.Mock;
  let updateMany: jest.Mock;
  let storageDelete: jest.Mock;
  let job: ConversionCleanupJob;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    update = jest.fn().mockResolvedValue({});
    updateMany = jest.fn().mockResolvedValue({ count: 0 });
    storageDelete = jest.fn().mockResolvedValue(undefined);

    const storage = {
      delete: storageDelete,
      buildKey: (userId: string, id: string) => `${userId}/${id}`,
    };

    job = new ConversionCleanupJob(
      {
        conversionOperation: { findMany, update, updateMany },
      } as unknown as PrismaService,
      { forDriver: () => storage } as unknown as StorageResolver,
    );

    jest.spyOn(job['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(job['logger'], 'warn').mockImplementation(() => undefined);
  });

  it('deletes results past their time and marks them gone, keeping the row', async () => {
    findMany
      .mockResolvedValueOnce([
        { id: 'op-1', resultKey: 'u/op-1.json', storageDriver: 'local' },
      ])
      .mockResolvedValueOnce([]);

    await job.run(NOW);

    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { resultExpiresAt: { lt: NOW }, resultKey: { not: null } },
    });
    expect(storageDelete).toHaveBeenCalledWith('results', 'u/op-1.json');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'op-1' },
      data: { resultKey: null, resultExpiresAt: null },
    });
    expect(job['logger'].log).toHaveBeenCalledWith({
      event: 'conversion.cleanup',
      expired: 1,
      interrupted: 0,
    });
  });

  it('leaves a result it could not delete for the next run', async () => {
    findMany
      .mockResolvedValueOnce([
        { id: 'op-1', resultKey: 'k', storageDriver: 'local' },
      ])
      .mockResolvedValueOnce([]);
    storageDelete.mockRejectedValue(new Error('storage down'));

    await job.run(NOW);

    expect(update).not.toHaveBeenCalled();
    expect(job['logger'].warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'conversion.cleanup_failed',
        operationId: 'op-1',
      }),
    );
  });

  it('fails operations a crash left PROCESSING, and deletes their uploads', async () => {
    findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'op-2', userId: 'u', storageDriver: 'local' },
      ]);
    updateMany.mockResolvedValue({ count: 1 });

    await job.run(NOW);

    expect(findMany.mock.calls[1][0]).toMatchObject({
      where: {
        status: 'PROCESSING',
        createdAt: { lt: new Date(NOW.getTime() - STALE_AFTER_MS) },
      },
    });
    expect(storageDelete).toHaveBeenCalledWith('uploads', 'u/op-2');
    expect(updateMany).toHaveBeenCalledWith({
      // Still PROCESSING: one that finished meanwhile is left alone.
      where: { id: { in: ['op-2'] }, status: 'PROCESSING' },
      data: {
        status: 'FAILED',
        errorCode: ERROR_CODES.INTERNAL_ERROR,
        errorMessage: 'The conversion was interrupted',
        finishedAt: NOW,
      },
    });
  });

  it('fails an interrupted operation even when its upload cannot be deleted', async () => {
    findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'op-3', userId: 'u', storageDriver: 'local' },
      ]);
    storageDelete.mockRejectedValue(new Error('storage down'));
    updateMany.mockResolvedValue({ count: 1 });

    await job.run(NOW);

    expect(updateMany).toHaveBeenCalled();
    expect(job['logger'].warn).toHaveBeenCalled();
  });

  it('is quiet when there is nothing to do', async () => {
    await job.run(NOW);

    expect(updateMany).not.toHaveBeenCalled();
    expect(job['logger'].log).not.toHaveBeenCalled();
  });
});
