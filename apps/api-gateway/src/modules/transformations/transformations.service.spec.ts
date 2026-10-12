import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';

import { AppError } from '@core/errors/app-error';
import { CONVERSION_RPC_PATTERNS } from '@contracts/messages/conversion.messages';
import type { RbacConfig } from '@contracts/messages/rbac.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { USERS_PATTERNS } from '@contracts/messages/users.messages';
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

  beforeEach(() => {
    conversionSend = jest.fn().mockReturnValue(of(PAGE));
    identitySend = jest
      .fn()
      .mockReturnValue(of({ userId: TARGET, active: true }));

    service = new TransformationsService(
      { send: conversionSend } as unknown as ClientProxy,
      { send: identitySend } as unknown as ClientProxy,
      { current: () => CONFIG } as unknown as RbacConfigCache,
    );

    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
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
});
