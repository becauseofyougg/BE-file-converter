import { JwtService } from '@nestjs/jwt';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { from, throwError } from 'rxjs';
import request from 'supertest';

import {
  CONVERSION_RPC_PATTERNS,
  type TransformationHistoryRequest,
} from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { RBAC_PATTERNS } from '@contracts/messages/rbac.messages';
import { USERS_PATTERNS } from '@contracts/messages/users.messages';
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

/**
 * The transformation history through the real HTTP stack — the guards, the
 * query validation, the RBAC cache — with identity and conversion-service
 * played by fakes. Identity serves the RBAC config as its migration makes it:
 * ADMIN holds `transformations@read`, USER does not.
 */
describe('transformation history (e2e)', () => {
  let app: NestFastifyApplication;
  let lastQuery: TransformationHistoryRequest | undefined;

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

  const conversion = {
    send: (pattern: string, payload: TransformationHistoryRequest) => {
      if (pattern === CONVERSION_RPC_PATTERNS.TRANSFORMATIONS) {
        lastQuery = payload;

        return from([{ items: [], nextCursor: null }]);
      }

      return throwError(() => new Error(`unexpected ${pattern}`));
    },
    close: () => undefined,
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(IDENTITY_CLIENT)
      .useValue(identity)
      .overrideProvider(CONVERSION_CLIENT)
      .useValue(conversion)
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

  it('documents both routes, and no longer the old list', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs/json')
      .expect(200);
    const paths = Object.keys((response.body as { paths: object }).paths);

    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/transformations/history',
        '/admin/users/{userId}/transformations/history',
        '/api/convert/history/{operationId}',
        '/api/convert/history/{operationId}/download',
      ]),
    );
    expect(paths).not.toContain('/api/convert/history');
  });
});
