import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('JobsController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/jobs (GET)', () => {
    return request(app.getHttpServer()).get('/jobs').expect(200).expect([]);
  });

  it('rate limits repeated job creation attempts', async () => {
    for (let requestNumber = 0; requestNumber < 5; requestNumber += 1) {
      await request(app.getHttpServer())
        .post('/jobs')
        .send({ urls: [] })
        .expect(400);
    }

    const throttledResponse = await request(app.getHttpServer())
      .post('/jobs')
      .send({ urls: [] })
      .expect(429);

    expect(throttledResponse.body as unknown).toMatchObject({
      message: 'Too many requests. Please try again later.',
    });
  });

  afterEach(async () => {
    await app.close();
  });
});
