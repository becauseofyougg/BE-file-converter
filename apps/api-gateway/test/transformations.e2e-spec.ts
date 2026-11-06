import { JwtService } from '@nestjs/jwt';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { from, throwError } from 'rxjs';
import request from 'supertest';

import {
  CONVERSION_RPC_PATTERNS,
  type TransformationHistoryRequest,
} from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { RBAC_PATTERNS } from '@contracts/messages/rbac.messages';
import { USERS_PATTERNS } from '@contracts/messages/users.messages';
import { FileStorage, type StorageDriverName } from '@storage/file-storage';
import { LocalFileStorage } from '@storage/local-file-storage';
import { STORAGE_BACKENDS } from '@storage/storage.constants';
import { AppModule } from '../src/app.module';
import { configureHttpApp } from '../src/http-app';
import {
  CONVERSION_CLIENT,
  IDENTITY_CLIENT,
} from '../src/messaging/messaging.module';
import { setupOpenApi } from '../src/openapi';

const ADMIN_ID = '6f1c2f34-0a4b-4c38-9d3a-1c5b2e7f8a90';
const USER_ID = '0b6c3c6e-55d4-4f5e-8f2a-6a4c1d2e3f40';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
/** USER_ID's saved result, kept in local storage. */
const SAVED_ITEM = '11111111-1111-4111-8111-111111111111';
/** USER_ID's result, saved once and past its time. */
const EXPIRED_ITEM = '22222222-2222-4222-8222-222222222222';
/** In the records, but no longer in storage. */
const VANISHED_ITEM = '33333333-3333-4333-8333-333333333333';

/**
 * The transformation history through the real HTTP stack — the guards, the
 * query validation, the RBAC cache — with identity and conversion-service
 * played by fakes. Identity serves the RBAC config as its migration makes it:
 * ADMIN holds `transformations@read`, USER does not.
 */
describe('transformation history (e2e)', () => {
  let app: NestFastifyApplication;
  let lastQuery: TransformationHistoryRequest | undefined;
  let root: string;
  let storage: LocalFileStorage;

  const identity = {
    send: (pattern: string, payload: { userId?: string }) => {
      if (pattern === RBAC_PATTERNS.GET_CONFIG) {
        return from([
          {
            version: 'e2e',
            generatedAt: new Date().toISOString(),
            permissions: [{ name: 'transformations', actions: ['read'] }],
            roles: [
              {
                name: 'ADMIN',
                grants: [{ permission: 'transformations', actions: [] }],
              },
              { name: 'USER', grants: [] },
            ],
          },
        ]);
      }

      if (pattern === USERS_PATTERNS.GET_STATUS) {
        return payload.userId === MISSING_ID
          ? throwError(() => ({
              error: {
                code: ERROR_CODES.USER_NOT_FOUND,
                message: 'User not found',
                httpStatus: 404,
              },
            }))
          : from([{ userId: payload.userId, active: true }]);
      }

      return throwError(() => new Error(`unexpected ${pattern}`));
    },
    emit: () => from([undefined]),
    connect: () => Promise.resolve(),
    close: () => undefined,
  };

  const refused = (code: string, message: string, httpStatus: number) =>
    throwError(() => ({ error: { code, message, httpStatus } }));

  /** What conversion-service answers — by owner and id together, as it does. */
  const conversion = {
    send: (
      pattern: string,
      payload: TransformationHistoryRequest & { operationId?: string },
    ) => {
      if (pattern === CONVERSION_RPC_PATTERNS.TRANSFORMATIONS) {
        lastQuery = payload;

        return from([{ items: [], nextCursor: null }]);
      }

      const own = payload.userId === USER_ID;

      if (pattern === CONVERSION_RPC_PATTERNS.HISTORY_GET) {
        return own && payload.operationId === SAVED_ITEM
          ? from([{ id: SAVED_ITEM, fileId: 'file-1' }])
          : refused(ERROR_CODES.JOB_NOT_FOUND, 'No such conversion', 404);
      }

      if (pattern === CONVERSION_RPC_PATTERNS.HISTORY_RESULT) {
        if (own && payload.operationId === EXPIRED_ITEM) {
          return refused(
            ERROR_CODES.RESULT_EXPIRED,
            'This saved result has expired and been deleted',
            410,
          );
        }

        if (
          own &&
          (payload.operationId === SAVED_ITEM ||
            payload.operationId === VANISHED_ITEM)
        ) {
          return from([
            {
              bucket: 'results',
              key: `${USER_ID}/${payload.operationId}.json`,
              driver: 'local',
              contentType: 'application/json; charset=utf-8',
              fileName: 'отчёт.json',
              size: 11,
              fileId: 'file-1',
            },
          ]);
        }

        return refused(ERROR_CODES.JOB_NOT_FOUND, 'No such conversion', 404);
      }

      return throwError(() => new Error(`unexpected ${pattern}`));
    },
    close: () => undefined,
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gateway-transformations-'));
    storage = new LocalFileStorage(root);
    await storage.put({
      bucket: 'results',
      key: `${USER_ID}/${SAVED_ITEM}.json`,
      body: Buffer.from('{"a":"one"}'),
    });

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(IDENTITY_CLIENT)
      .useValue(identity)
      .overrideProvider(CONVERSION_CLIENT)
      .useValue(conversion)
      .overrideProvider(STORAGE_BACKENDS)
      .useValue(new Map<StorageDriverName, FileStorage>([['local', storage]]))
      .overrideProvider(FileStorage)
      .useValue(storage)
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await configureHttpApp(app);
    setupOpenApi(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    lastQuery = undefined;
  });

  const tokenFor = (id: string, roles: string[]) =>
    new JwtService().sign(
      { sub: id, roles, jti: `e2e-${id}` },
      {
        secret: process.env.JWT_SECRET as string,
        algorithm: 'HS256',
        expiresIn: '5m',
      },
    );

  const get = (path: string, token?: string) => {
    const call = request(app.getHttpServer()).get(path);

    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  const code = (body: unknown) => (body as { code?: string }).code;

  describe('GET /api/transformations/history', () => {
    it('needs a session', async () => {
      const response = await get('/api/transformations/history').expect(401);

      expect(code(response.body)).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it("asks for the caller's own history, with the filters as given", async () => {
      await get(
        '/api/transformations/history?type=IMAGE&status=error&sourceFormat=SVG&limit=5&createdAtFrom=2026-10-01T00:00:00Z',
        tokenFor(USER_ID, ['USER']),
      ).expect(200);

      expect(lastQuery).toEqual({
        type: 'image',
        status: 'error',
        sourceFormat: 'svg',
        limit: 5,
        createdAtFrom: '2026-10-01T00:00:00Z',
        userId: USER_ID,
        correlationId: expect.any(String) as string,
      });
    });

    it('takes no userId from the query', async () => {
      const response = await get(
        `/api/transformations/history?userId=${ADMIN_ID}`,
        tokenFor(USER_ID, ['USER']),
      ).expect(400);

      expect(code(response.body)).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(lastQuery).toBeUndefined();
    });

    it.each([
      'type=video',
      'status=done',
      'limit=0',
      'limit=101',
      'sourceFormat=../csv',
      'createdAtFrom=yesterday',
    ])('refuses %s before asking anyone', async (filter) => {
      const response = await get(
        `/api/transformations/history?${filter}`,
        tokenFor(USER_ID, ['USER']),
      ).expect(400);

      expect(code(response.body)).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(lastQuery).toBeUndefined();
    });
  });

  describe('GET /admin/users/:userId/transformations/history', () => {
    const path = (id: string) => `/admin/users/${id}/transformations/history`;

    it('needs a session', async () => {
      await get(path(USER_ID)).expect(401);
    });

    it('is 403 without transformations@read', async () => {
      const response = await get(
        path(ADMIN_ID),
        tokenFor(USER_ID, ['USER']),
      ).expect(403);

      expect(code(response.body)).toBe(ERROR_CODES.FORBIDDEN);
      expect(lastQuery).toBeUndefined();
    });

    it("serves the named user's history to a holder of it", async () => {
      await get(
        `${path(USER_ID)}?status=success`,
        tokenFor(ADMIN_ID, ['ADMIN']),
      ).expect(200);

      expect(lastQuery).toMatchObject({ userId: USER_ID, status: 'success' });
    });

    it('is 404 for a user that does not exist', async () => {
      const response = await get(
        path(MISSING_ID),
        tokenFor(ADMIN_ID, ['ADMIN']),
      ).expect(404);

      expect(code(response.body)).toBe(ERROR_CODES.USER_NOT_FOUND);
      expect(lastQuery).toBeUndefined();
    });

    it('is 400 for an id that is not one', async () => {
      await get(path('not-a-uuid'), tokenFor(ADMIN_ID, ['ADMIN'])).expect(400);
    });
  });

  describe('saved results', () => {
    const own = `/api/transformations/history/${SAVED_ITEM}`;

    it("reads one of the caller's own items in full", async () => {
      const response = await get(own, tokenFor(USER_ID, ['USER'])).expect(200);

      expect(response.body).toMatchObject({ id: SAVED_ITEM, fileId: 'file-1' });
    });

    it('downloads it, named after the upload, in both spellings', async () => {
      const response = await get(
        `${own}/download`,
        tokenFor(USER_ID, ['USER']),
      ).expect(200);

      expect(response.text).toBe('{"a":"one"}');
      expect(response.headers['content-type']).toBe(
        'application/json; charset=utf-8',
      );
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="_____.json"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.json`,
      );
      expect(response.headers['x-result-saved']).toBeUndefined();
    });

    it('serves the same file again, while it exists', async () => {
      const first = await get(`${own}/download`, tokenFor(USER_ID, ['USER']));
      const second = await get(`${own}/download`, tokenFor(USER_ID, ['USER']));

      expect(second.text).toBe(first.text);
    });

    /** Another user's id is the same 404 as no id: no IDOR, no oracle. */
    it("is 404 for someone else's item", async () => {
      const response = await get(
        `${own}/download`,
        tokenFor(ADMIN_ID, ['USER']),
      ).expect(404);

      expect(code(response.body)).toBe(ERROR_CODES.JOB_NOT_FOUND);
    });

    it('is 410 once its time has passed', async () => {
      const response = await get(
        `/api/transformations/history/${EXPIRED_ITEM}/download`,
        tokenFor(USER_ID, ['USER']),
      ).expect(410);

      expect(code(response.body)).toBe(ERROR_CODES.RESULT_EXPIRED);
    });

    it('is 410 when the record outlived the file', async () => {
      const response = await get(
        `/api/transformations/history/${VANISHED_ITEM}/download`,
        tokenFor(USER_ID, ['USER']),
      ).expect(410);

      expect(code(response.body)).toBe(ERROR_CODES.RESULT_EXPIRED);
    });

    it('is 401 without a session', async () => {
      await get(`${own}/download`).expect(401);
    });

    describe('for an administrator', () => {
      const adminPath = (userId: string, itemId = SAVED_ITEM) =>
        `/admin/users/${userId}/transformations/history/${itemId}/download`;

      it("downloads any user's saved result", async () => {
        const response = await get(
          adminPath(USER_ID),
          tokenFor(ADMIN_ID, ['ADMIN']),
        ).expect(200);

        expect(response.text).toBe('{"a":"one"}');
      });

      it('is 403 without transformations@read', async () => {
        await get(adminPath(USER_ID), tokenFor(ADMIN_ID, ['USER'])).expect(403);
      });

      it('is 404 for a user that does not exist', async () => {
        const response = await get(
          adminPath(MISSING_ID),
          tokenFor(ADMIN_ID, ['ADMIN']),
        ).expect(404);

        expect(code(response.body)).toBe(ERROR_CODES.USER_NOT_FOUND);
      });

      it('is 404 for an item of another user than the one named', async () => {
        const response = await get(
          adminPath(ADMIN_ID),
          tokenFor(ADMIN_ID, ['ADMIN']),
        ).expect(404);

        expect(code(response.body)).toBe(ERROR_CODES.JOB_NOT_FOUND);
      });

      it('is 400 for ids that are not ids', async () => {
        await get(
          adminPath(USER_ID, 'nope'),
          tokenFor(ADMIN_ID, ['ADMIN']),
        ).expect(400);
      });
    });
  });

  it('documents both routes, and no longer the old list', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs/json')
      .expect(200);
    const paths = Object.keys((response.body as { paths: object }).paths);

    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/transformations/history',
        '/admin/users/{userId}/transformations/history',
        '/api/transformations/history/{itemId}',
        '/api/transformations/history/{itemId}/download',
        '/admin/users/{userId}/transformations/history/{itemId}/download',
      ]),
    );
    expect(
      paths.filter((path) => path.startsWith('/api/convert/history')),
    ).toEqual([]);
  });
});
