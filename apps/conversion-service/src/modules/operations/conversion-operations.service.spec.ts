import type { DiscoveryService } from '@nestjs/core';
import type { ConversionOperation } from '@prisma-clients/conversion';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import type { ConvertFileRequest } from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { FileStorage, StorageDriverName } from '@storage/file-storage';
import { LocalFileStorage } from '@storage/local-file-storage';
import { StorageResolver } from '@storage/storage-resolver';
import type { ConversionConfig } from '../../config/conversion.config';
import type { PrismaService } from '../../database/prisma.service';
import { ConverterRegistry } from '../converters/converter-registry';
import type { WorkerRunner } from '../converters/worker-runner';
import { DataConverter } from '../data/data.converter';
import { transform, type TransformRequest } from '../data/data-transform';
import { ConversionLimits } from './conversion-limits';
import { ConversionOperationsService } from './conversion-operations.service';
import { encodeCursor } from './operation-record';

const USER = '0b6c3c6e-55d4-4f5e-8f2a-6a4c1d2e3f40';

/** The table, in memory: enough of Prisma for what the service does to it. */
function fakePrisma() {
  const rows = new Map<string, ConversionOperation>();

  const conversionOperation = {
    create: jest.fn(({ data }: { data: Partial<ConversionOperation> }) => {
      const row = {
        status: 'PROCESSING',
        sourceFormat: null,
        sourceChecksum: null,
        resultSize: null,
        resultChecksum: null,
        resultKey: null,
        resultExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        durationMs: null,
        createdAt: new Date(),
        finishedAt: null,
        ...data,
      } as ConversionOperation;

      rows.set(row.id, row);

      return Promise.resolve(row);
    }),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<ConversionOperation>;
      }) => {
        const row = { ...rows.get(where.id)!, ...data };

        rows.set(where.id, row);

        return Promise.resolve(row);
      },
    ),
    findFirst: jest.fn(
      ({ where }: { where: { id: string; userId: string } }) => {
        const row = rows.get(where.id);

        return Promise.resolve(row && row.userId === where.userId ? row : null);
      },
    ),
    findMany: jest.fn(),
  };

  return {
    rows,
    prisma: { conversionOperation } as unknown as PrismaService,
    conversionOperation,
  };
}

describe('ConversionOperationsService', () => {
  let root: string;
  let storage: LocalFileStorage;
  let table: ReturnType<typeof fakePrisma>;
  let env: Record<string, string | number | undefined>;
  let service: ConversionOperationsService;
  let backends: Map<StorageDriverName, FileStorage>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'conversion-ops-'));
    storage = new LocalFileStorage(root);
    backends = new Map<StorageDriverName, FileStorage>([['local', storage]]);
    table = fakePrisma();
    env = {
      CONVERSION_SYNC_TIMEOUT_MS: 30_000,
      CONVERSION_UNSAVED_RESULT_MINUTES: 15,
      CONVERSION_MAX_BYTES_DEFAULT: 1024 * 1024,
      CONVERSION_MAX_DEPTH: 64,
      CONVERSION_WORKER_MEMORY_MB: 128,
    };

    const config = {
      get: (key: string) => env[key],
      getNumber: (key: string) => Number(env[key]),
    } as unknown as ConfigService<ConversionConfig>;

    const runner = {
      run: (_entry: string, request: TransformRequest) =>
        Promise.resolve(transform(request)),
    } as unknown as WorkerRunner;

    const registry = new ConverterRegistry({} as DiscoveryService);

    jest.spyOn(registry['logger'], 'log').mockImplementation(() => undefined);
    registry.register([new DataConverter(runner, config)]);

    service = new ConversionOperationsService(
      table.prisma,
      registry,
      new ConversionLimits(config),
      storage,
      new StorageResolver(backends),
      config,
    );

    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(service['logger'], level).mockImplementation(() => undefined);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Puts `content` where the gateway would have, and describes it. */
  async function upload(
    content: string | Buffer,
    overrides: Partial<ConvertFileRequest> & {
      name?: string;
      size?: number;
    } = {},
  ): Promise<ConvertFileRequest> {
    const operationId = randomUUID();
    const key = storage.buildKey(USER, operationId);
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);

    await storage.put({ bucket: 'uploads', key, body });

    const { name, size, ...rest } = overrides;

    return {
      operationId,
      userId: USER,
      source: {
        bucket: 'uploads',
        key,
        driver: 'local',
        name: name ?? 'people.csv',
        size: size ?? body.length,
      },
      targetFormat: 'json',
      save: false,
      correlationId: 'corr-1',
      ...rest,
    };
  }

  const uploadExists = (request: ConvertFileRequest) =>
    storage.getStream('uploads', request.source.key).then(
      (stream) => {
        stream.destroy();
        return true;
      },
      () => false,
    );

  async function refusal(request: ConvertFileRequest): Promise<AppError> {
    const error = await service
      .convert(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  describe('convert', () => {
    it('converts, stores the result, records it, and deletes the upload', async () => {
      const csv = 'id,name\r\n1,Ann\r\n';
      const request = await upload(csv);

      const response = await service.convert(request);

      expect(response.result).toEqual({
        bucket: 'results',
        key: `${USER}/${request.operationId}.json`,
        driver: 'local',
        contentType: 'application/json; charset=utf-8',
        fileName: 'converted.json',
        size: expect.any(Number) as number,
      });

      const stored = await readFile(
        join(root, 'results', response.result.key),
        'utf8',
      );

      expect(JSON.parse(stored)).toEqual([{ id: '1', name: 'Ann' }]);
      expect(response.result.size).toBe(Buffer.byteLength(stored));
      expect(await uploadExists(request)).toBe(false);

      expect(response.operation).toMatchObject({
        id: request.operationId,
        status: 'COMPLETED',
        source: {
          name: 'people.csv',
          format: 'csv',
          size: csv.length,
          checksum: createHash('sha256').update(csv).digest('hex'),
        },
        target: {
          format: 'json',
          size: response.result.size,
          checksum: createHash('sha256').update(stored).digest('hex'),
        },
        saved: false,
        resultAvailable: false,
        error: null,
      });
    });

    it('gives an unsaved result an expiry, and a saved one none', async () => {
      const before = Date.now();

      await service.convert(await upload('a\r\n1\r\n'));
      const unsaved = [...table.rows.values()][0];

      expect(unsaved.resultExpiresAt!.getTime()).toBeGreaterThanOrEqual(
        before + 15 * 60_000,
      );

      const saved = await service.convert(
        await upload('a\r\n1\r\n', { save: true }),
      );

      expect(table.rows.get(saved.operation.id)!.resultExpiresAt).toBeNull();
      expect(saved.operation.resultAvailable).toBe(true);
    });

    it('accepts the target in any case', async () => {
      const response = await service.convert(
        await upload('a\r\n1\r\n', { targetFormat: 'YAML' }),
      );

      expect(response.result.fileName).toBe('converted.yaml');
    });

    it('writes an audit line with the facts and none of the content or the name', async () => {
      const request = await upload('secret,values\r\n1,2\r\n', {
        name: 'payroll-2026.csv',
      });

      await service.convert(request);

      const entry = (service['logger'].log as jest.Mock).mock
        .calls[0][0] as Record<string, unknown>;

      expect(entry).toEqual({
        event: 'conversion.audit',
        operationId: request.operationId,
        correlationId: 'corr-1',
        userId: USER,
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: request.source.size,
        result: 'success',
        code: null,
        durationMs: expect.any(Number) as number,
      });
      expect(JSON.stringify(entry)).not.toMatch(/payroll|secret/);
    });

    describe('refusals, in the documented order', () => {
      it('an unknown target: 400, before reading anything', async () => {
        const request = await upload('not even csv', {
          name: 'x.bin',
          targetFormat: 'toml',
        });

        const error = await refusal(request);

        expect(error).toMatchObject({
          code: ERROR_CODES.UNSUPPORTED_CONVERSION,
          httpStatus: 400,
          details: { supported: ['csv', 'json', 'xml', 'yaml'] },
        });
      });

      it('a format nobody reads: 415', async () => {
        const error = await refusal(
          await upload('a,b\n1,2\n', { name: 'data.txt' }),
        );

        expect(error).toMatchObject({
          code: ERROR_CODES.UNSUPPORTED_FORMAT,
          httpStatus: 415,
        });
      });

      it("over the format's own limit: 413", async () => {
        env.CONVERSION_MAX_BYTES_CSV = 8;

        const error = await refusal(await upload('a,b\r\n1,2\r\n3,4\r\n'));

        const request = await upload('a,b\r\n1,2\r\n3,4\r\n');
        const recorded = await refusal(request);

        expect(error).toMatchObject({
          code: ERROR_CODES.FILE_TOO_LARGE,
          httpStatus: 413,
          details: { format: 'csv', maxBytes: 8 },
        });
        expect(recorded.code).toBe(ERROR_CODES.FILE_TOO_LARGE);
        // Refused for its size, still recorded as what it was.
        expect(table.rows.get(request.operationId)!.sourceFormat).toBe('csv');
      });

      it('over the default limit when the format has none: 413', async () => {
        env.CONVERSION_MAX_BYTES_DEFAULT = 4;

        const error = await refusal(
          await upload('[1, 2, 3]', { name: 'a.json', targetFormat: 'csv' }),
        );

        expect(error.code).toBe(ERROR_CODES.FILE_TOO_LARGE);
      });

      /** The declared size is the gateway's count; the read does not rely on it. */
      it('over the limit while claiming to be under it: 413, stopped mid-read', async () => {
        env.CONVERSION_MAX_BYTES_CSV = 5000;

        const big = `a\r\n${'1\r\n'.repeat(4000)}`;
        const error = await refusal(await upload(big, { size: 10 }));

        expect(error.code).toBe(ERROR_CODES.FILE_TOO_LARGE);
      });

      it('a small file over the limit while claiming to be under it: 413', async () => {
        env.CONVERSION_MAX_BYTES_CSV = 6;

        const error = await refusal(
          await upload('a\r\n1\r\n2\r\n', { size: 1 }),
        );

        expect(error.code).toBe(ERROR_CODES.FILE_TOO_LARGE);
      });

      it('a pair that does not go: 400', async () => {
        const error = await refusal(
          await upload('a\r\n1\r\n', { targetFormat: 'csv' }),
        );

        expect(error).toMatchObject({
          code: ERROR_CODES.UNSUPPORTED_CONVERSION,
          httpStatus: 400,
        });
        expect(error.message).toBe('Cannot convert csv to csv');
      });

      it('a file that does not parse: 400, with what was learned recorded', async () => {
        const request = await upload('{"a":', {
          name: 'a.json',
          targetFormat: 'xml',
        });

        const error = await refusal(request);

        expect(error).toMatchObject({
          code: ERROR_CODES.INVALID_SOURCE,
          httpStatus: 400,
        });

        const row = table.rows.get(request.operationId)!;

        expect(row).toMatchObject({
          status: 'FAILED',
          sourceFormat: 'json',
          errorCode: ERROR_CODES.INVALID_SOURCE,
          errorMessage: error.message,
        });
        expect(row.sourceChecksum).toHaveLength(64);
        expect(row.finishedAt).toBeInstanceOf(Date);
      });
    });

    it('records the refusal, logs it as a warning, and still deletes the upload', async () => {
      const request = await upload('a,b\n1,2\n', { name: 'data.txt' });

      await refusal(request);

      expect(table.rows.get(request.operationId)!.status).toBe('FAILED');
      expect(service['logger'].warn).toHaveBeenCalledWith(
        expect.objectContaining({
          result: 'failure',
          code: ERROR_CODES.UNSUPPORTED_FORMAT,
        }),
      );
      expect(await uploadExists(request)).toBe(false);
    });

    it('says so when the upload is not there', async () => {
      const request = await upload('a\r\n1\r\n');

      await storage.delete('uploads', request.source.key);

      const error = await refusal(request);

      expect(error).toMatchObject({
        code: ERROR_CODES.INVALID_SOURCE,
        message: 'The uploaded file is gone',
      });
    });

    it('answers 503 when the upload is in storage this deployment lacks', async () => {
      const request = await upload('a\r\n1\r\n');

      const error = await refusal({
        ...request,
        source: { ...request.source, driver: 's3' },
      });

      expect(error).toMatchObject({
        code: ERROR_CODES.STORAGE_UNAVAILABLE,
        httpStatus: 503,
      });
    });

    it('answers 503 when storage fails, not 500', async () => {
      const request = await upload('a\r\n1\r\n');

      jest.spyOn(storage, 'put').mockRejectedValue(new Error('disk full'));

      const error = await refusal(request);

      expect(error).toMatchObject({
        code: ERROR_CODES.STORAGE_UNAVAILABLE,
        httpStatus: 503,
      });
    });

    it('records an unexpected failure as INTERNAL_ERROR, without its text', async () => {
      const request = await upload('a\r\n1\r\n');

      jest.spyOn(service['registry'], 'converterFor').mockImplementation(() => {
        throw new TypeError('bug with internals in it');
      });

      await expect(service.convert(request)).rejects.toThrow(TypeError);
      expect(table.rows.get(request.operationId)).toMatchObject({
        status: 'FAILED',
        errorCode: ERROR_CODES.INTERNAL_ERROR,
        errorMessage: 'Internal error',
      });
    });

    it('deletes a stored result that could not be recorded', async () => {
      const request = await upload('a\r\n1\r\n');

      table.conversionOperation.update.mockRejectedValueOnce(
        new Error('db gone'),
      );

      await expect(service.convert(request)).rejects.toThrow('db gone');
      await expect(
        storage.getStream('results', `${USER}/${request.operationId}.json`),
      ).rejects.toThrow();
    });

    it('still reports the original failure when recording it fails too', async () => {
      const request = await upload('a,b\n1,2\n', { name: 'data.txt' });

      table.conversionOperation.update.mockRejectedValue(new Error('db gone'));

      const error = await refusal(request);

      expect(error.code).toBe(ERROR_CODES.UNSUPPORTED_FORMAT);
      expect(service['logger'].error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'conversion.record_failed' }),
      );
    });

    it('logs, and does not fail, when the upload cannot be deleted', async () => {
      const request = await upload('a\r\n1\r\n');

      jest.spyOn(storage, 'delete').mockRejectedValue(new Error('locked'));

      await expect(service.convert(request)).resolves.toBeDefined();
      expect(service['logger'].warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'conversion.storage_delete_failed' }),
      );
    });
  });

  describe('history', () => {
    const row = (id: string, createdAt: string) =>
      ({
        id,
        userId: USER,
        status: 'COMPLETED',
        sourceName: 'a.csv',
        sourceFormat: 'csv',
        sourceSize: BigInt(3),
        sourceChecksum: null,
        targetFormat: 'json',
        resultSize: BigInt(5),
        resultChecksum: null,
        resultKey: null,
        storageDriver: 'local',
        saved: false,
        resultExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        durationMs: 4,
        correlationId: 'c',
        createdAt: new Date(createdAt),
        finishedAt: null,
      }) as ConversionOperation;

    const A = '00000000-0000-4000-8000-00000000000a';
    const B = '00000000-0000-4000-8000-00000000000b';
    const C = '00000000-0000-4000-8000-00000000000c';

    it("pages the user's operations newest first, with a cursor for the next page", async () => {
      table.conversionOperation.findMany.mockResolvedValue([
        row(C, '2026-10-02T12:00:00Z'),
        row(B, '2026-10-02T11:00:00Z'),
        row(A, '2026-10-02T10:00:00Z'),
      ]);

      const page = await service.history({ userId: USER, limit: 2 });

      expect(table.conversionOperation.findMany).toHaveBeenCalledWith({
        where: { userId: USER },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      });
      expect(page.items.map((item) => item.id)).toEqual([C, B]);
      expect(page.nextCursor).toBe(
        encodeCursor(row(B, '2026-10-02T11:00:00Z')),
      );
    });

    it('continues after the cursor, tie-broken by id', async () => {
      table.conversionOperation.findMany.mockResolvedValue([]);

      const at = new Date('2026-10-02T11:00:00Z');
      const page = await service.history({
        userId: USER,
        cursor: encodeCursor({ createdAt: at, id: B }),
      });

      expect(table.conversionOperation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: USER,
            OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: B } }],
          },
          take: 21,
        }),
      );
      expect(page).toEqual({ items: [], nextCursor: null });
    });

    it('clamps the page size', async () => {
      table.conversionOperation.findMany.mockResolvedValue([]);

      await service.history({ userId: USER, limit: 10_000 });
      await service.history({ userId: USER, limit: 0 });

      expect(
        table.conversionOperation.findMany.mock.calls.map(
          (call) => call[0].take,
        ),
      ).toEqual([101, 2]);
    });

    it.each([
      'garbage',
      Buffer.from('2026-10-02T11:00:00Z|not-a-uuid').toString('base64url'),
    ])('refuses a cursor it did not issue: %s', async (cursor) => {
      await expect(
        service.history({ userId: USER, cursor }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.VALIDATION_FAILED,
        httpStatus: 400,
      });
    });
  });

  describe('operation and savedResult', () => {
    it("finds the user's own operation", async () => {
      const done = await service.convert(
        await upload('a\r\n1\r\n', { save: true }),
      );

      await expect(
        service.operation({ userId: USER, operationId: done.operation.id }),
      ).resolves.toMatchObject({ id: done.operation.id, status: 'COMPLETED' });
    });

    it("treats another user's operation as no operation", async () => {
      const done = await service.convert(
        await upload('a\r\n1\r\n', { save: true }),
      );

      await expect(
        service.operation({
          userId: randomUUID(),
          operationId: done.operation.id,
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.JOB_NOT_FOUND,
        httpStatus: 404,
      });
    });

    it('says where a saved result is', async () => {
      const done = await service.convert(
        await upload('a\r\n1\r\n', { save: true, targetFormat: 'xml' }),
      );

      await expect(
        service.savedResult({ userId: USER, operationId: done.operation.id }),
      ).resolves.toEqual(done.result);
    });

    it('refuses an unsaved result', async () => {
      const done = await service.convert(await upload('a\r\n1\r\n'));

      await expect(
        service.savedResult({ userId: USER, operationId: done.operation.id }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.RESULT_NOT_SAVED,
        message: 'This result was not saved',
      });
    });

    it('refuses a failed conversion, which has no result', async () => {
      const request = await upload('{', { name: 'a.json', save: true });

      await refusal(request);

      await expect(
        service.savedResult({ userId: USER, operationId: request.operationId }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.RESULT_NOT_SAVED,
        message: 'This conversion has no result',
      });
    });
  });
});
