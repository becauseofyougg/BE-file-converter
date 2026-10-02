import { JwtService } from '@nestjs/jwt';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defer, from, throwError } from 'rxjs';
import request from 'supertest';

import {
  CONVERSION_RPC_PATTERNS,
  type ConvertFileRequest,
} from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { FileStorage, type StorageDriverName } from '@storage/file-storage';
import { LocalFileStorage } from '@storage/local-file-storage';
import { STORAGE_BACKENDS } from '@storage/storage.constants';
import { AppModule } from '../src/app.module';
import { configureHttpApp } from '../src/http-app';
import { CONVERSION_CLIENT } from '../src/messaging/messaging.module';
import { setupOpenApi } from '../src/openapi';

const USER = '6f1c2f34-0a4b-4c38-9d3a-1c5b2e7f8a90';

/**
 * `/api/convert` through the real HTTP stack — Fastify, the multipart
 * plugin and its limits, the guards, the error envelope — with storage in a
 * temporary directory and conversion-service played by a fake that does what
 * the real one does with storage: reads the upload, deletes it, writes a
 * result. What is under test is the gateway's half.
 */
describe('/api/convert (e2e)', () => {
  let app: NestFastifyApplication;
  let root: string;
  let storage: LocalFileStorage;
  let lastRequest: ConvertFileRequest | undefined;
  let refuseWith: object | undefined;

  const conversion = {
    send: (pattern: string, payload: unknown) => {
      if (pattern === CONVERSION_RPC_PATTERNS.FORMATS) {
        return from([[{ source: 'csv', target: ['json', 'xml', 'yaml'] }]]);
      }

      if (pattern === CONVERSION_RPC_PATTERNS.CONVERT) {
        if (refuseWith) {
          const error = refuseWith;

          return throwError(() => ({ error, message: 'refused' }));
        }

        return defer(() => from(fakeConvert(payload as ConvertFileRequest)));
      }

      return throwError(() => new Error(`unexpected ${pattern}`));
    },
    close: () => undefined,
  };

  async function fakeConvert(payload: ConvertFileRequest) {
    lastRequest = payload;

    const chunks: Buffer[] = [];

    for await (const chunk of await storage.getStream(
      'uploads',
      payload.source.key,
    )) {
      chunks.push(chunk as Buffer);
    }

    await storage.delete('uploads', payload.source.key);

    const body = Buffer.from(
      JSON.stringify({ received: Buffer.concat(chunks).toString() }),
    );
    const key = storage.buildKey(payload.userId, payload.operationId, 'json');

    await storage.put({ bucket: 'results', key, body });

    return {
      operation: { id: payload.operationId },
      result: {
        bucket: 'results',
        key,
        driver: 'local',
        contentType: 'application/json; charset=utf-8',
        fileName: 'converted.json',
        size: body.length,
      },
    };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gateway-convert-'));
    storage = new LocalFileStorage(root);

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
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
    lastRequest = undefined;
    refuseWith = undefined;
  });

  const token = new JwtService().sign(
    { sub: USER, roles: ['USER'], jti: 'e2e-convert' },
    {
      secret: process.env.JWT_SECRET as string,
      algorithm: 'HS256',
      expiresIn: '5m',
    },
  );

  const post = () =>
    request(app.getHttpServer())
      .post('/api/convert')
      .set('Authorization', `Bearer ${token}`);

  const code = (body: unknown) => (body as { code?: string }).code;

  /** Nothing left behind in either bucket — every path cleans up. */
  const filesIn = async (bucket: string) => {
    const userDir = join(root, bucket, USER);

    return readdir(userDir).catch(() => [] as string[]);
  };

  it('needs a session', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/convert')
      .attach('file', Buffer.from('a\r\n1\r\n'), 'a.csv')
      .field('targetFormat', 'json')
      .expect(401);

    expect(code(response.body)).toBe(ERROR_CODES.UNAUTHENTICATED);
  });

  it('streams the upload through, and the result back as an attachment', async () => {
    const response = await post()
      .field('targetFormat', 'JSON')
      .attach('file', Buffer.from('id,name\r\n1,Ann\r\n'), 'people.csv')
      .expect(200);

    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="converted.json"',
    );
    expect(response.headers['x-conversion-id']).toBe(lastRequest!.operationId);
    expect(JSON.parse(response.text)).toEqual({
      received: 'id,name\r\n1,Ann\r\n',
    });

    expect(lastRequest).toMatchObject({
      userId: USER,
      targetFormat: 'json',
      save: false,
      source: {
        bucket: 'uploads',
        driver: 'local',
        name: 'people.csv',
        size: 16,
      },
    });

    // The unsaved result is deleted once sent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await filesIn('uploads')).toEqual([]);
    expect(await filesIn('results')).toEqual([]);
  });

  it('accepts the fields after the file, and keeps a saved result', async () => {
    await post()
      .attach('file', Buffer.from('[1]'), 'a.json')
      .field('targetFormat', 'csv')
      .field('save', 'true')
      .expect(200);

    expect(lastRequest!.save).toBe(true);
    expect(await filesIn('results')).toEqual([
      `${lastRequest!.operationId}.json`,
    ]);
  });

  it.each([
    [
      'no target',
      (r: request.Test) => r.attach('file', Buffer.from('x'), 'a.csv'),
    ],
    [
      'a malformed target',
      (r: request.Test) =>
        r
          .field('targetFormat', 'js on')
          .attach('file', Buffer.from('x'), 'a.csv'),
    ],
    [
      'an unknown field',
      (r: request.Test) =>
        r
          .field('targetFormat', 'json')
          .field('mode', 'x')
          .attach('file', Buffer.from('x'), 'a.csv'),
    ],
    ['no file', (r: request.Test) => r.field('targetFormat', 'json')],
    [
      'two files',
      (r: request.Test) =>
        r
          .field('targetFormat', 'json')
          .attach('file', Buffer.from('x'), 'a.csv')
          .attach('file', Buffer.from('y'), 'b.csv'),
    ],
  ])('refuses %s with 400, leaving nothing behind', async (_case, build) => {
    const response = await build(post()).expect(400);

    expect(code(response.body)).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(lastRequest).toBeUndefined();
    expect(await filesIn('uploads')).toEqual([]);
  });

  it('refuses a body that is not multipart', async () => {
    const response = await post().send({ targetFormat: 'json' }).expect(400);

    expect(code(response.body)).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it('refuses an empty file', async () => {
    const response = await post()
      .field('targetFormat', 'json')
      .attach('file', Buffer.alloc(0), 'a.csv')
      .expect(400);

    expect(code(response.body)).toBe(ERROR_CODES.INVALID_SOURCE);
  });

  it("refuses an upload over the edge's ceiling with 413, and keeps none of it", async () => {
    const response = await post()
      .field('targetFormat', 'json')
      .attach('file', Buffer.alloc(70_000, 'a'), 'a.csv')
      .expect(413);

    expect(code(response.body)).toBe(ERROR_CODES.FILE_TOO_LARGE);
    expect(lastRequest).toBeUndefined();
    expect(await filesIn('uploads')).toEqual([]);
  });

  it("answers with conversion-service's refusal, code and status intact", async () => {
    refuseWith = {
      code: ERROR_CODES.UNSUPPORTED_FORMAT,
      message: 'The file is not in a format this service reads',
      httpStatus: 415,
    };

    const response = await post()
      .field('targetFormat', 'json')
      .attach('file', Buffer.from('x'), 'a.bin')
      .expect(415);

    expect(code(response.body)).toBe(ERROR_CODES.UNSUPPORTED_FORMAT);
    expect(await filesIn('uploads')).toEqual([]);
  });

  it('lists the formats in the shape the spec fixes', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/convert/formats')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual([
      { source: 'csv', target: ['json', 'xml', 'yaml'] },
    ]);
  });

  it('refuses a malformed history id with 400, before asking anyone', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/convert/history/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    expect(code(response.body)).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it('documents the upload as multipart in the OpenAPI document', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs/json')
      .expect(200);
    const paths = (
      response.body as { paths: Record<string, Record<string, unknown>> }
    ).paths;

    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        '/api/convert',
        '/api/convert/formats',
        '/api/convert/history',
        '/api/convert/history/{operationId}',
        '/api/convert/history/{operationId}/download',
      ]),
    );
    expect(
      Object.keys(
        (paths['/api/convert'].post as { requestBody: { content: object } })
          .requestBody.content,
      ),
    ).toEqual(['multipart/form-data']);
  });
});
