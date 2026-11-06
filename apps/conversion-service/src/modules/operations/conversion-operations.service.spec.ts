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
import { ImageConverter } from '../image/image.converter';
import { transform, type TransformRequest } from '../data/data-transform';
import { ConversionLimits } from './conversion-limits';
import { ConversionOperationsService } from './conversion-operations.service';

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
      IMAGE_MAX_WIDTH: 1000,
      IMAGE_MAX_HEIGHT: 1000,
      IMAGE_MAX_PIXELS: 1_000_000,
      HISTORY_RETENTION_DAYS: 90,
      CONVERSION_MAX_SAVED_BYTES: 1024 * 1024,
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
    registry.register([
      new DataConverter(runner, config),
      new ImageConverter(config),
    ]);

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

    it('keeps an unsaved result for minutes, a saved one for the retention period', async () => {
      const before = Date.now();

      await service.convert(await upload('a\r\n1\r\n'));
      const unsaved = [...table.rows.values()][0];

      expect(unsaved.resultExpiresAt!.getTime()).toBeGreaterThanOrEqual(
        before + 15 * 60_000,
      );
      expect(unsaved.resultExpiresAt!.getTime()).toBeLessThan(
        before + 16 * 60_000,
      );
      expect(unsaved).toMatchObject({ saved: false, fileId: null });

      const saved = await service.convert(
        await upload('a\r\n1\r\n', { save: true }),
      );
      const row = table.rows.get(saved.operation.id)!;

      expect(row.resultExpiresAt!.getTime()).toBeGreaterThanOrEqual(
        before + 90 * 24 * 60 * 60_000,
      );
      expect(saved.operation).toMatchObject({
        saved: true,
        resultAvailable: true,
      });
      expect(saved.operation.fileId).toMatch(/^[0-9a-f-]{36}$/);
      expect(saved.result.fileId).toBe(saved.operation.fileId);
      // The conversion's own response is named as its spec fixes.
      expect(saved.result.fileName).toBe('converted.json');
    });

    it('audits the save: who, which file, how big, how long', async () => {
      const request = await upload('a\r\n1\r\n', { save: true });
      const response = await service.convert(request);

      expect(service['logger'].log).toHaveBeenCalledWith({
        event: 'conversion.file.save',
        userId: USER,
        transformationId: request.operationId,
        fileId: response.operation.fileId,
        fileSize: response.result.size,
        durationMs: expect.any(Number) as number,
        result: 'success',
      });
    });

    it('returns a result too large to keep, but does not keep it', async () => {
      env.CONVERSION_MAX_SAVED_BYTES = 5;

      const request = await upload('a\r\n1\r\n', { save: true });
      const response = await service.convert(request);

      expect(response.operation).toMatchObject({
        status: 'COMPLETED',
        saved: false,
        fileId: null,
      });
      expect(response.result).not.toHaveProperty('fileId');
      expect(service['logger'].warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'conversion.file.save',
          result: 'failure',
          fileId: null,
          reason: 'larger than the 5 bytes a saved file may be',
        }),
      );
      // Kept only as long as an unsaved result is.
      expect(
        table.rows.get(request.operationId)!.resultExpiresAt!.getTime(),
      ).toBeLessThan(Date.now() + 16 * 60_000);
    });

    it('writes no save audit line when nothing was asked to be saved', async () => {
      await service.convert(await upload('a\r\n1\r\n'));

      expect(
        (service['logger'].log as jest.Mock).mock.calls.some(
          ([entry]: [{ event: string }]) =>
            entry.event === 'conversion.file.save',
        ),
      ).toBe(false);
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
          details: {
            supported: ['csv', 'jpeg', 'json', 'png', 'svg', 'xml', 'yaml'],
          },
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

  describe('images, and a route held to one family', () => {
    const SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="5" height="5"/></svg>';

    it('converts an image through the same pipeline, keeping its options', async () => {
      const request = await upload(SVG, {
        name: 'logo.svg',
        targetFormat: 'jpeg',
        options: { width: 40, quality: 90 },
      });

      const response = await service.convert(request);

      expect(response.result).toMatchObject({
        contentType: 'image/jpeg',
        fileName: 'converted.jpeg',
      });
      expect(response.operation).toMatchObject({
        source: { format: 'svg' },
        options: { width: 40, quality: 90 },
      });
      expect(
        table.conversionOperation.create.mock.calls[0][0].data.options,
      ).toEqual({
        width: 40,
        quality: 90,
      });
    });

    it('records no options as none', async () => {
      const response = await service.convert(
        await upload('a\r\n1\r\n', { options: {} }),
      );

      expect(response.operation.options).toBeNull();
    });

    it('recognises an SVG over XML, whatever the module order', async () => {
      const response = await service.convert(
        await upload(SVG, { name: 'upload', targetFormat: 'png' }),
      );

      expect(response.operation.source.format).toBe('svg');
    });

    describe('records what kind of transformation it was', () => {
      const family = (operationId: string) =>
        table.rows.get(operationId)!.family;

      it('from the converter that ran it', async () => {
        const image = await upload(SVG, { name: 'a.svg', targetFormat: 'png' });
        const data = await upload('a\r\n1\r\n');

        await service.convert(image);
        await service.convert(data);

        expect(family(image.operationId)).toBe('image');
        expect(family(data.operationId)).toBe('data');
      });

      it('from the source, when the pair does not go', async () => {
        const request = await upload(SVG, {
          name: 'a.svg',
          targetFormat: 'csv',
        });

        await refusal(request);

        expect(family(request.operationId)).toBe('image');
      });

      it("from the route's family, when the file is not recognised", async () => {
        const request = await upload('?', {
          name: 'x.bin',
          targetFormat: 'png',
          family: 'image',
        });

        await refusal(request);

        expect(
          table.conversionOperation.create.mock.calls[0][0].data.family,
        ).toBe('image');
        expect(family(request.operationId)).toBe('image');
      });

      it('from the target, when nothing else says', async () => {
        const request = await upload('?', {
          name: 'x.bin',
          targetFormat: 'jpeg',
        });

        await refusal(request);

        expect(family(request.operationId)).toBe('image');
      });

      it('as data, when nothing is known at all', async () => {
        const request = await upload('?', {
          name: 'x.bin',
          targetFormat: 'toml',
        });

        await refusal(request);

        expect(family(request.operationId)).toBe('data');
      });
    });

    it('refuses options the direction does not take, before converting', async () => {
      const error = await refusal(
        await upload('a\r\n1\r\n', { options: { quality: 80 } }),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.VALIDATION_FAILED,
        httpStatus: 400,
        details: { errors: ['quality does not apply to csv → json'] },
      });
    });

    it('a family route takes only its formats as targets', async () => {
      const error = await refusal(
        await upload(SVG, {
          name: 'logo.svg',
          targetFormat: 'json',
          family: 'image',
        }),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.UNSUPPORTED_CONVERSION,
        details: { supported: ['jpeg', 'png', 'svg'] },
      });
    });

    it('a family route takes only its formats as sources: 415', async () => {
      const error = await refusal(
        await upload('a\r\n1\r\n', { targetFormat: 'png', family: 'image' }),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.UNSUPPORTED_FORMAT,
        httpStatus: 415,
        details: { supported: ['png', 'jpeg', 'svg'] },
      });
    });

    it('a family route reads an <svg> in a .xml file as the SVG it is', async () => {
      const response = await service.convert(
        await upload(SVG, {
          name: 'drawing.xml',
          targetFormat: 'png',
          family: 'image',
        }),
      );

      expect(response.operation.source.format).toBe('svg');
    });

    it('names what a source can become when the pair does not go', async () => {
      const png = Buffer.from(
        (
          await new ImageConverter({
            getNumber: (key: string) => env[key],
          } as never).convert({
            data: Buffer.from(SVG),
            source: 'svg',
            target: 'png',
            options: {},
            timeoutMs: 5_000,
          })
        ).data,
      );
      const error = await refusal(
        await upload(png, {
          name: 'a.png',
          targetFormat: 'svg',
          family: 'image',
        }),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.UNSUPPORTED_CONVERSION,
        message: 'Cannot convert png to svg',
        details: { supported: ['jpeg'] },
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

    it('says where a saved result is, named after the upload', async () => {
      const done = await service.convert(
        await upload('a\r\n1\r\n', { save: true, targetFormat: 'xml' }),
      );

      await expect(
        service.savedResult({ userId: USER, operationId: done.operation.id }),
      ).resolves.toEqual({
        ...done.result,
        fileName: 'people.xml',
        fileId: done.operation.fileId,
      });
    });

    it('answers 410 for a saved result past its time', async () => {
      const done = await service.convert(
        await upload('a\r\n1\r\n', { save: true }),
      );
      const row = table.rows.get(done.operation.id)!;

      row.resultExpiresAt = new Date(Date.now() - 1);

      await expect(
        service.savedResult({ userId: USER, operationId: done.operation.id }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.RESULT_EXPIRED,
        httpStatus: 410,
      });

      // …and once the clean-up has taken the file, the same.
      row.resultExpiresAt = new Date(Date.now() + 60_000);
      row.resultKey = null;

      await expect(
        service.savedResult({ userId: USER, operationId: done.operation.id }),
      ).rejects.toMatchObject({ httpStatus: 410 });
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
