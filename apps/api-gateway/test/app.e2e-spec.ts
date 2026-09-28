import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppModule } from '../src/app.module';
import { configureHttpApp } from '../src/http-app';

describe('api-gateway (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // Built the way main.ts builds it — Fastify, the error envelope, cookies —
    // so a refusal arrives here as the status and `code` a client would see.
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await configureHttpApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports the service as up', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect((response.body as { status: string }).status).toBe('ok');
  });

  /**
   * The authenticator chain as the real app wires it: the global guard, the
   * `AUTHENTICATORS` list, and the controller-level `@UseGuards` on the admin
   * routes. No broker is running, so the RBAC config never loads and RBAC
   * denies everything — which is what makes 401 and 403 tell apart "the
   * authenticator refused" from "the authenticator accepted, RBAC refused".
   */
  describe('authentication', () => {
    const sign = (secret: string) =>
      new JwtService().sign(
        {
          sub: '6f1c2f34-0a4b-4c38-9d3a-1c5b2e7f8a90',
          roles: ['ADMIN'],
          jti: 'e2e',
        },
        { secret, algorithm: 'HS256', expiresIn: '5m' },
      );

    const code = (body: unknown) => (body as { code?: string }).code;

    it('refuses a protected route with no credentials', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/users')
        .expect(401);

      expect(code(response.body)).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('refuses a token signed with some other secret', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/users')
        .set(
          'Authorization',
          `Bearer ${sign('a-different-secret-that-is-long-enough')}`,
        )
        .expect(401);

      expect(code(response.body)).toBe(ERROR_CODES.UNAUTHENTICATED);
    });

    it('accepts a genuine token, and hands the caller on to RBAC', async () => {
      const response = await request(app.getHttpServer())
        .get('/admin/users')
        .set(
          'Authorization',
          `Bearer ${sign(process.env.JWT_SECRET as string)}`,
        )
        .expect(403);

      expect(code(response.body)).toBe(ERROR_CODES.FORBIDDEN);
    });

    /** How a browser authenticates — through the real cookie plugin. */
    it('accepts the same token from the access cookie', async () => {
      await request(app.getHttpServer())
        .get('/admin/users')
        .set('Cookie', `access_token=${sign(process.env.JWT_SECRET as string)}`)
        .expect(403);
    });

    it('does not let a bad cookie fall back to a good header', async () => {
      await request(app.getHttpServer())
        .get('/admin/users')
        .set('Cookie', 'access_token=forged')
        .set(
          'Authorization',
          `Bearer ${sign(process.env.JWT_SECRET as string)}`,
        )
        .expect(401);
    });
  });
});
