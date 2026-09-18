import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';

describe('api-gateway (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
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
});
