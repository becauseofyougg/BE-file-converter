import type { ClientProxy } from '@nestjs/microservices';
import type { FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { of, throwError } from 'rxjs';

import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import {
  CONVERSION_RPC_PATTERNS,
  type ConvertFileRequest,
} from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { type FileStorage, ObjectNotFoundError } from '@storage/file-storage';
import type { StorageResolver } from '@storage/storage-resolver';
import type { GatewayConfig } from '../../config/gateway.config';
import { ConversionsService } from './conversions.service';

const USER = '0b6c3c6e-55d4-4f5e-8f2a-6a4c1d2e3f40';

const RESULT = {
  bucket: 'results' as const,
  key: `${USER}/op.json`,
  driver: 'local',
  contentType: 'application/json; charset=utf-8',
  fileName: 'converted.json',
  size: 2,
};

/** A multipart request holding `fields` and one file. */
const requestWith = (fields: Record<string, string>, content = 'id\r\n1\r\n') =>
  ({
    isMultipart: () => true,
    parts: async function* () {
      yield await Promise.resolve({
        type: 'file',
        fieldname: 'file',
        filename: 'a.csv',
        file: Readable.from([Buffer.from(content)]),
      });

      for (const [fieldname, value] of Object.entries(fields)) {
        yield await Promise.resolve({ type: 'field', fieldname, value });
      }
    },
  }) as unknown as FastifyRequest;

describe('ConversionsService', () => {
  let send: jest.Mock;
  let storage: {
    driver: string;
    put: jest.Mock;
    delete: jest.Mock;
    getStream: jest.Mock;
    buildKey: (userId: string, id: string) => string;
  };
  let service: ConversionsService;

  beforeEach(() => {
    send = jest.fn();
    storage = {
      driver: 'local',
      put: jest.fn(async ({ body }: { body: Readable }) => {
        for await (const chunk of body) {
          void chunk;
        }
      }),
      delete: jest.fn().mockResolvedValue(undefined),
      getStream: jest
        .fn()
        .mockResolvedValue(Readable.from([Buffer.from('[]')])),
      buildKey: (userId, id) => `${userId}/${id}`,
    };

    service = new ConversionsService(
      { send } as unknown as ClientProxy,
      storage as unknown as FileStorage,
      { forDriver: () => storage } as unknown as StorageResolver,
      {
        getNumber: (key: string) =>
          ({
            CONVERSION_UPLOAD_MAX_BYTES: 1024,
            CONVERSION_RPC_TIMEOUT_MS: 45_000,
          })[key],
      } as unknown as ConfigService<GatewayConfig>,
    );

    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  describe('convert', () => {
    it('uploads, asks conversion-service, and opens the result', async () => {
      send.mockReturnValue(of({ operation: {}, result: RESULT }));

      const result = await service.convert(
        requestWith({ targetFormat: 'JSON', save: 'true' }),
        USER,
        'corr',
      );

      const [pattern, payload] = send.mock.calls[0] as [
        string,
        ConvertFileRequest,
      ];

      expect(pattern).toBe(CONVERSION_RPC_PATTERNS.CONVERT);
      expect(payload).toEqual({
        operationId: result.operationId,
        userId: USER,
        source: {
          bucket: 'uploads',
          key: `${USER}/${result.operationId}`,
          driver: 'local',
          name: 'a.csv',
          size: 7,
        },
        targetFormat: 'json',
        save: true,
        correlationId: 'corr',
      });
      expect(storage.put).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'uploads',
          key: `${USER}/${result.operationId}`,
        }),
      );
      expect(result.file).toEqual(RESULT);
      expect(storage.getStream).toHaveBeenCalledWith('results', RESULT.key);
    });

    it('deletes an unsaved result once it has been sent', async () => {
      send.mockReturnValue(of({ operation: {}, result: RESULT }));

      const { stream } = await service.convert(
        requestWith({ targetFormat: 'json' }),
        USER,
        'c',
      );

      stream.resume();
      await new Promise((resolve) => stream.once('close', resolve));
      await new Promise(setImmediate);

      expect(storage.delete).toHaveBeenCalledWith('results', RESULT.key);
    });

    it('keeps a saved result', async () => {
      send.mockReturnValue(of({ operation: {}, result: RESULT }));

      const { stream } = await service.convert(
        requestWith({ targetFormat: 'json', save: '1' }),
        USER,
        'c',
      );

      stream.resume();
      await new Promise((resolve) => stream.once('close', resolve));

      expect(storage.delete).not.toHaveBeenCalledWith('results', RESULT.key);
    });

    it('refuses an empty file without asking anyone', async () => {
      await expect(
        service.convert(requestWith({ targetFormat: 'json' }, ''), USER, 'c'),
      ).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_SOURCE,
        httpStatus: 400,
      });
      expect(send).not.toHaveBeenCalled();
    });

    it("passes conversion-service's refusal on, and deletes the upload", async () => {
      send.mockReturnValue(
        throwError(() => ({
          error: {
            code: ERROR_CODES.UNSUPPORTED_FORMAT,
            message: 'not a format this service reads',
            httpStatus: 415,
          },
          message: 'x',
        })),
      );

      await expect(
        service.convert(requestWith({ targetFormat: 'json' }), USER, 'c'),
      ).rejects.toMatchObject({
        code: ERROR_CODES.UNSUPPORTED_FORMAT,
        httpStatus: 415,
      });
      expect(storage.delete).toHaveBeenCalledWith(
        'uploads',
        expect.stringMatching(`^${USER}/`),
      );
    });

    it('answers 503 when the result cannot be read', async () => {
      send.mockReturnValue(of({ operation: {}, result: RESULT }));
      storage.getStream.mockRejectedValue(new Error('gone'));

      await expect(
        service.convert(requestWith({ targetFormat: 'json' }), USER, 'c'),
      ).rejects.toMatchObject({
        code: ERROR_CODES.STORAGE_UNAVAILABLE,
        httpStatus: 503,
      });
    });

    it('answers 410 when the record and storage disagree — the file is gone', async () => {
      send.mockReturnValue(of({ operation: {}, result: RESULT }));
      storage.getStream.mockRejectedValue(
        new ObjectNotFoundError('results', RESULT.key),
      );

      await expect(
        service.convert(requestWith({ targetFormat: 'json' }), USER, 'c'),
      ).rejects.toMatchObject({
        code: ERROR_CODES.RESULT_EXPIRED,
        httpStatus: 410,
      });
      expect(service['logger'].error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'conversion.result_missing' }),
      );
    });

    it('says whether the result was kept', async () => {
      send.mockReturnValue(of({ operation: { saved: false }, result: RESULT }));

      const result = await service.convert(
        requestWith({ targetFormat: 'json', save: 'true' }),
        USER,
        'c',
      );

      expect(result.saved).toBe(false);
    });

    it('passes a storage refusal that is already an AppError on unchanged', async () => {
      send.mockReturnValue(of({ operation: {}, result: RESULT }));
      storage.getStream.mockRejectedValue(
        new AppError(ERROR_CODES.STORAGE_UNAVAILABLE, 'not configured', 503),
      );

      await expect(
        service.convert(requestWith({ targetFormat: 'json' }), USER, 'c'),
      ).rejects.toMatchObject({ message: 'not configured' });
    });

    it('logs, and does not fail, when the upload cannot be deleted', async () => {
      send.mockReturnValue(of({ operation: {}, result: RESULT }));
      storage.delete.mockRejectedValue(new Error('locked'));

      await expect(
        service.convert(
          requestWith({ targetFormat: 'json', save: 'true' }),
          USER,
          'c',
        ),
      ).resolves.toBeDefined();
      expect(service['logger'].warn).toHaveBeenCalled();
    });
  });

  it('asks for the formats once a minute at most', async () => {
    send.mockReturnValue(of([{ source: 'csv', target: ['json'] }]));

    await service.formats('a');
    const second = await service.formats('b');

    expect(second).toEqual([{ source: 'csv', target: ['json'] }]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("caches each family's formats apart from the whole list", async () => {
    send.mockReturnValue(of([]));

    await service.formats('a');
    await service.formats('b', 'image');
    await service.formats('c', 'image');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(CONVERSION_RPC_PATTERNS.FORMATS, {
      family: 'image',
      correlationId: 'b',
    });
  });

  it("sends a route's family and the options it read", async () => {
    send.mockReturnValue(of({ operation: {}, result: RESULT }));

    await service.convert(
      requestWith({ targetFormat: 'jpeg', quality: '70' }),
      USER,
      'c',
      { family: 'image', flatOptions: ['quality'] },
    );

    expect(send.mock.calls[0][1]).toMatchObject({
      targetFormat: 'jpeg',
      options: { quality: 70 },
      family: 'image',
    });
  });

  it('sends neither when there are none', async () => {
    send.mockReturnValue(of({ operation: {}, result: RESULT }));

    await service.convert(requestWith({ targetFormat: 'json' }), USER, 'c');

    expect(send.mock.calls[0][1]).not.toHaveProperty('options');
    expect(send.mock.calls[0][1]).not.toHaveProperty('family');
  });
});
