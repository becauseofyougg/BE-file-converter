import type { ClientProxy } from '@nestjs/microservices';
import { Readable } from 'node:stream';
import { of, throwError } from 'rxjs';

import { AppError } from '@core/errors/app-error';
import { CONVERSION_RPC_PATTERNS } from '@contracts/messages/conversion.messages';
import type { RbacConfig } from '@contracts/messages/rbac.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { USERS_PATTERNS } from '@contracts/messages/users.messages';
import type { StorageResolver } from '@storage/storage-resolver';
import type { RequestUser } from '../auth/request-user';
import type { RbacConfigCache } from '../rbac/rbac-config.cache';
import { TransformationsService } from './transformations.service';

const ADMIN_ID = '6f1c2f34-0a4b-4c38-9d3a-1c5b2e7f8a90';
const TARGET = '0b6c3c6e-55d4-4f5e-8f2a-6a4c1d2e3f40';

/** The RBAC config as identity builds it, with `transformations@read` for ADMIN. */
const CONFIG = {
  version: '7',
  generatedAt: '2026-10-12T00:00:00.000Z',
  permissions: [{ name: 'transformations', actions: ['read'] }],
  roles: [
    { name: 'ADMIN', grants: [{ permission: 'transformations', actions: [] }] },
    { name: 'USER', grants: [] },
  ],
} as unknown as RbacConfig;

const PAGE = {
  items: [
    {
      id: 'op-1',
      type: 'file',
      sourceFormat: 'csv',
      targetFormat: 'json',
      status: 'success',
      fileSize: 10,
      durationMs: 5,
      resultAvailable: false,
      createdAt: '2026-10-12T00:00:00.000Z',
    },
  ],
  nextCursor: null,
};

const user = (roles: string[], id = ADMIN_ID): RequestUser => ({
  id,
  roles,
  tokenId: 't',
});

describe('TransformationsService', () => {
  let conversionSend: jest.Mock;
  let identitySend: jest.Mock;
  let service: TransformationsService;
  let getStream: jest.Mock;

  beforeEach(() => {
    conversionSend = jest.fn().mockReturnValue(of(PAGE));
    getStream = jest
      .fn()
      .mockResolvedValue(Readable.from([Buffer.from('data')]));
    identitySend = jest
      .fn()
      .mockReturnValue(of({ userId: TARGET, active: true }));

    service = new TransformationsService(
      { send: conversionSend } as unknown as ClientProxy,
      { send: identitySend } as unknown as ClientProxy,
      { current: () => CONFIG } as unknown as RbacConfigCache,
      { forDriver: () => ({ getStream }) } as unknown as StorageResolver,
    );

    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  const auditEntry = (level: 'log' | 'warn') =>
    (service['logger'][level] as jest.Mock).mock.calls[0][0] as Record<
      string,
      unknown
    >;

  async function refusal(promise: Promise<unknown>): Promise<AppError> {
    const error = await promise.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  describe('own history', () => {
    it("asks for the caller's own id, whatever else it is given", async () => {
      const self = user(['USER'], TARGET);

      await expect(
        service.history(self, { kind: 'self' }, { status: 'error' }, 'c-1'),
      ).resolves.toEqual(PAGE);

      expect(identitySend).toHaveBeenCalledWith(USERS_PATTERNS.GET_STATUS, {
        userId: TARGET,
        correlationId: 'c-1',
      });
      expect(conversionSend).toHaveBeenCalledWith(
        CONVERSION_RPC_PATTERNS.TRANSFORMATIONS,
        { status: 'error', userId: TARGET, correlationId: 'c-1' },
      );
    });

    it('needs no permission', async () => {
      await service.history(user([], TARGET), { kind: 'self' }, {}, 'c');

      expect(conversionSend).toHaveBeenCalled();
    });

    it('treats a session outliving its account as a 401', async () => {
      identitySend.mockReturnValue(
        throwError(() => ({
          error: {
            code: ERROR_CODES.USER_NOT_FOUND,
            message: 'User not found',
            httpStatus: 404,
          },
        })),
      );

      const error = await refusal(
        service.history(user(['USER'], TARGET), { kind: 'self' }, {}, 'c'),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.UNAUTHENTICATED,
        httpStatus: 401,
      });
      expect(conversionSend).not.toHaveBeenCalled();
    });

    it('audits the read without a target, and the cursor only as present', async () => {
      await service.history(
        user(['USER'], TARGET),
        { kind: 'self' },
        { cursor: 'opaque-position', type: 'image' },
        'c',
      );

      expect(auditEntry('log')).toEqual({
        event: 'transformations.history.read',
        actorUserId: TARGET,
        scope: 'self',
        query: { cursor: '[present]', type: 'image' },
        status: 200,
        returned: 1,
      });
    });
  });

  describe("another user's history", () => {
    const admin = { kind: 'admin' as const, targetUserId: TARGET };

    it('is served to a holder of transformations@read, for that user', async () => {
      await expect(
        service.history(user(['ADMIN']), admin, { limit: 5 }, 'c'),
      ).resolves.toEqual(PAGE);

      expect(identitySend).toHaveBeenCalledWith(USERS_PATTERNS.GET_STATUS, {
        userId: TARGET,
        correlationId: 'c',
      });
      expect(conversionSend).toHaveBeenCalledWith(
        CONVERSION_RPC_PATTERNS.TRANSFORMATIONS,
        { limit: 5, userId: TARGET, correlationId: 'c' },
      );
      expect(auditEntry('log')).toMatchObject({
        actorUserId: ADMIN_ID,
        targetUserId: TARGET,
        scope: 'admin',
        status: 200,
        returned: 1,
      });
    });

    /** 403 before any lookup: otherwise the route says which ids are real. */
    it('is refused with 403 to anyone else, before the user is looked up', async () => {
      const error = await refusal(
        service.history(user(['USER']), admin, {}, 'c'),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.FORBIDDEN,
        httpStatus: 403,
      });
      expect(identitySend).not.toHaveBeenCalled();
      expect(conversionSend).not.toHaveBeenCalled();
      expect(auditEntry('warn')).toMatchObject({
        actorUserId: ADMIN_ID,
        targetUserId: TARGET,
        status: 403,
        returned: 0,
      });
    });

    it('answers 404 for a user that does not exist, and audits it', async () => {
      identitySend.mockReturnValue(
        throwError(() => ({
          error: {
            code: ERROR_CODES.USER_NOT_FOUND,
            message: 'User not found',
            httpStatus: 404,
          },
        })),
      );

      const error = await refusal(
        service.history(user(['ADMIN']), admin, {}, 'c'),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.USER_NOT_FOUND,
        httpStatus: 404,
      });
      expect(conversionSend).not.toHaveBeenCalled();
      expect(auditEntry('warn')).toMatchObject({ status: 404 });
    });
  });

  it('passes on a refused query, and audits its status', async () => {
    conversionSend.mockReturnValue(
      throwError(() => ({
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'The history query is not valid',
          httpStatus: 400,
        },
      })),
    );

    const error = await refusal(
      service.history(user(['USER'], TARGET), { kind: 'self' }, {}, 'c'),
    );

    expect(error.httpStatus).toBe(400);
    expect(auditEntry('warn')).toMatchObject({ status: 400 });
  });

  it('audits an unexpected failure as a 500', async () => {
    conversionSend.mockReturnValue(throwError(() => new Error('broker gone')));

    await expect(
      service.history(user(['USER'], TARGET), { kind: 'self' }, {}, 'c'),
    ).rejects.toThrow('broker gone');
    expect(auditEntry('warn')).toMatchObject({ status: 500 });
  });

  it("reads one of the caller's own operations, for the caller's id only", async () => {
    conversionSend.mockReturnValue(of({ id: 'op-1' }));

    await service.operation(user(['USER'], TARGET), 'op-1', 'c');

    expect(conversionSend).toHaveBeenCalledWith(
      CONVERSION_RPC_PATTERNS.HISTORY_GET,
      { userId: TARGET, operationId: 'op-1', correlationId: 'c' },
    );
  });

  describe('download', () => {
    const FILE = {
      bucket: 'results',
      key: `${TARGET}/op-1.json`,
      driver: 'local',
      contentType: 'application/json; charset=utf-8',
      fileName: 'people.json',
      size: 4,
      fileId: 'file-1',
    };

    beforeEach(() => {
      conversionSend.mockReturnValue(of(FILE));
    });

    /** Read to the end, as a client does; the audit line is written on close. */
    const drain = async (stream: Readable) => {
      for await (const chunk of stream) {
        void chunk;
      }

      await new Promise(setImmediate);
    };

    it('streams a saved result of ones own, and audits the transfer', async () => {
      const result = await service.download(
        user(['USER'], TARGET),
        { kind: 'self' },
        'op-1',
        'c',
      );

      expect(conversionSend).toHaveBeenCalledWith(
        CONVERSION_RPC_PATTERNS.HISTORY_RESULT,
        { userId: TARGET, operationId: 'op-1', correlationId: 'c' },
      );
      expect(result).toMatchObject({ file: FILE, operationId: 'op-1' });

      await drain(result.stream);

      expect(auditEntry('log')).toEqual({
        event: 'transformations.file.download',
        actorUserId: TARGET,
        scope: 'self',
        transformationId: 'op-1',
        fileId: 'file-1',
        fileSize: 4,
        status: 200,
        result: 'success',
        durationMs: expect.any(Number) as number,
      });
    });

    it("streams another user's to a holder of transformations@read", async () => {
      const result = await service.download(
        user(['ADMIN']),
        { kind: 'admin', targetUserId: TARGET },
        'op-1',
        'c',
      );

      expect(conversionSend).toHaveBeenCalledWith(
        CONVERSION_RPC_PATTERNS.HISTORY_RESULT,
        { userId: TARGET, operationId: 'op-1', correlationId: 'c' },
      );

      await drain(result.stream);

      expect(auditEntry('log')).toMatchObject({
        actorUserId: ADMIN_ID,
        targetUserId: TARGET,
        scope: 'admin',
      });
    });

    it('refuses anyone else with 403, before any lookup, and audits it', async () => {
      const error = await refusal(
        service.download(
          user(['USER']),
          { kind: 'admin', targetUserId: TARGET },
          'op-1',
          'c',
        ),
      );

      expect(error.httpStatus).toBe(403);
      expect(identitySend).not.toHaveBeenCalled();
      expect(conversionSend).not.toHaveBeenCalled();
      expect(auditEntry('warn')).toMatchObject({
        event: 'transformations.file.download',
        status: 403,
        result: 'failure',
        fileId: null,
      });
    });

    it("passes on the service's refusal — expired, not saved — and audits it", async () => {
      conversionSend.mockReturnValue(
        throwError(() => ({
          error: {
            code: ERROR_CODES.RESULT_EXPIRED,
            message: 'This saved result has expired and been deleted',
            httpStatus: 410,
          },
        })),
      );

      const error = await refusal(
        service.download(user(['USER'], TARGET), { kind: 'self' }, 'op-1', 'c'),
      );

      expect(error).toMatchObject({
        code: ERROR_CODES.RESULT_EXPIRED,
        httpStatus: 410,
      });
      expect(auditEntry('warn')).toMatchObject({ status: 410 });
    });

    it('records a transfer the client abandoned as not completed', async () => {
      const result = await service.download(
        user(['USER'], TARGET),
        { kind: 'self' },
        'op-1',
        'c',
      );

      result.stream.destroy();
      await new Promise(setImmediate);

      expect(auditEntry('warn')).toMatchObject({
        status: 499,
        result: 'failure',
      });
    });

    it('audits an unexpected failure as a 500', async () => {
      getStream.mockRejectedValue('odd');

      await expect(
        service.download(user(['USER'], TARGET), { kind: 'self' }, 'op-1', 'c'),
      ).rejects.toMatchObject({ httpStatus: 503 });
      expect(auditEntry('warn')).toMatchObject({ status: 503 });

      (service['logger'].warn as jest.Mock).mockClear();
      conversionSend.mockReturnValue(
        throwError(() => new Error('broker gone')),
      );

      await expect(
        service.download(user(['USER'], TARGET), { kind: 'self' }, 'op-1', 'c'),
      ).rejects.toThrow('broker gone');
      expect(auditEntry('warn')).toMatchObject({ status: 500 });
    });
  });
});
