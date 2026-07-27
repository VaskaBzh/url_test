import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/app.config';
import { AppModule } from '../src/app.module';
import { UrlSafetyService } from '../src/jobs/url-safety.service';

interface CreateJobResponseBody {
  readonly jobId: string;
}

interface UrlCheckResponseBody {
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly errorMessage?: string;
  readonly httpStatus?: number;
  readonly startedAt?: string;
  readonly status: string;
  readonly url: string;
}

interface JobStatusResponseBody {
  readonly createdAt: string;
  readonly id: string;
  readonly status: string;
  readonly urlChecks: readonly UrlCheckResponseBody[];
}

describe('Jobs API (e2e)', () => {
  let application: INestApplication<App>;
  let headServer: Server;
  let headServerBaseUrl: string;

  beforeAll(async () => {
    headServer = createServer((incomingRequest, serverResponse) => {
      if (incomingRequest.url?.startsWith('/failure')) {
        incomingRequest.socket.destroy();
        return;
      }
      serverResponse.writeHead(204).end();
    });
    await new Promise<void>((resolve) =>
      headServer.listen(0, '127.0.0.1', resolve),
    );
    const serverAddress = headServer.address();
    if (!serverAddress || typeof serverAddress === 'string') {
      throw new Error('Expected an IP socket address for the HEAD test server');
    }
    headServerBaseUrl = `http://127.0.0.1:${serverAddress.port}`;
  });

  beforeEach(async () => {
    const testingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(UrlSafetyService)
      .useValue({
        isPublicAddress: () => true,
        resolvePublicAddress: (parsedUrl: URL) =>
          Promise.resolve({
            address: parsedUrl.hostname,
            family: parsedUrl.hostname.includes(':') ? 6 : 4,
          }),
      })
      .compile();
    application = testingModule.createNestApplication({ logger: false });
    configureApplication(application);
    await application.init();
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  it('rate limits repeated job creation attempts', async () => {
    for (let requestNumber = 0; requestNumber < 5; requestNumber += 1) {
      await request(application.getHttpServer())
        .post('/api/jobs')
        .send({ urls: [] })
        .expect(400);
    }

    const throttledResponse = await request(application.getHttpServer())
      .post('/api/jobs')
      .send({ urls: [] })
      .expect(429);

    expect(throttledResponse.body as unknown).toMatchObject({
      message: 'Too many requests. Please try again later.',
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await application.close();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      headServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('uses the production API prefix', async () => {
    await request(application.getHttpServer()).get('/jobs').expect(404);
    await request(application.getHttpServer())
      .get('/api/jobs')
      .expect(200)
      .expect([]);
  });

  it('creates, processes, lists, and retrieves a job using stable contracts', async () => {
    const checkedUrl = `${headServerBaseUrl}/success?token=sensitive`;
    const createResponse = await request(application.getHttpServer())
      .post('/api/jobs')
      .send({ urls: [`  ${checkedUrl}  `] })
      .expect(201);
    const createResponseBody = parseCreateJobResponse(
      createResponse.body as unknown,
    );
    expect(createResponseBody).toEqual({ jobId: createResponseBody.jobId });

    const jobDetails = await waitForJobStatus(
      application,
      createResponseBody.jobId,
      'completed',
    );
    expect(jobDetails.id).toBe(createResponseBody.jobId);
    expect(jobDetails.status).toBe('completed');
    expect(jobDetails.createdAt).not.toBe('');
    expect(jobDetails.urlChecks).toHaveLength(1);
    expect(jobDetails.urlChecks[0]).toMatchObject({
      httpStatus: 204,
      status: 'success',
      url: checkedUrl,
    });
    expect(jobDetails.urlChecks[0].startedAt).not.toBeUndefined();
    expect(jobDetails.urlChecks[0].completedAt).not.toBeUndefined();
    expect(jobDetails.urlChecks[0].durationMs).not.toBeUndefined();

    const listResponse = await request(application.getHttpServer())
      .get('/api/jobs')
      .expect(200);
    const listResponseBody: unknown = listResponse.body;
    expect(listResponseBody).toEqual([
      {
        createdAt: jobDetails.createdAt,
        errorUrls: 0,
        id: createResponseBody.jobId,
        status: 'completed',
        successfulUrls: 1,
        totalUrls: 1,
      },
    ]);
  });

  it.each([
    [{}, 'urls must be an array'],
    [{ urls: [] }, 'urls must contain at least one item'],
    [{ urls: ['ftp://localhost/file'] }, 'urls[0] must use http or https'],
  ])(
    'returns a stable validation envelope',
    async (payload, expectedMessage) => {
      await request(application.getHttpServer())
        .post('/api/jobs')
        .send(payload)
        .expect(400)
        .expect({
          error: 'Bad Request',
          message: expectedMessage,
          statusCode: 400,
        });
    },
  );

  it('returns a generic not-found contract for job endpoints', async () => {
    const expectedResponse = {
      error: 'Not Found',
      message: 'Job was not found',
      statusCode: 404,
    };

    await request(application.getHttpServer())
      .get('/api/jobs/missing-job')
      .expect(404)
      .expect(expectedResponse);
    await request(application.getHttpServer())
      .delete('/api/jobs/missing-job')
      .expect(404)
      .expect(expectedResponse);
  });

  it('keeps cancellation of a terminal job idempotent and bodyless', async () => {
    const createResponse = await request(application.getHttpServer())
      .post('/api/jobs')
      .send({ urls: [`${headServerBaseUrl}/success`] })
      .expect(201);
    const { jobId } = parseCreateJobResponse(createResponse.body as unknown);
    await waitForJobStatus(application, jobId, 'completed');

    await request(application.getHttpServer())
      .delete(`/api/jobs/${jobId}`)
      .expect(204)
      .expect('');
    await request(application.getHttpServer())
      .delete(`/api/jobs/${jobId}`)
      .expect(204)
      .expect('');
  });

  it('sanitizes expected request errors and warning logs', async () => {
    const warningLogger = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const sensitiveUrl = `${headServerBaseUrl}/failure?token=private`;
    const createResponse = await request(application.getHttpServer())
      .post('/api/jobs')
      .send({ urls: [sensitiveUrl] })
      .expect(201);
    const { jobId } = parseCreateJobResponse(createResponse.body as unknown);

    const jobDetails = await waitForJobStatus(application, jobId, 'completed');
    expect(jobDetails.urlChecks).toHaveLength(1);
    expect(jobDetails.urlChecks[0]).toMatchObject({
      errorMessage: 'Unable to reach URL.',
      status: 'error',
    });
    const warningOutput = warningLogger.mock.calls.flat().join(' ');
    expect(warningOutput).toContain(jobId);
    expect(warningOutput).toContain('"urlIndex":0');
    expect(warningOutput).not.toContain(sensitiveUrl);
    expect(warningOutput).not.toContain('private');
  });
});

async function waitForJobStatus(
  application: INestApplication<App>,
  jobId: string,
  expectedStatus: string,
): Promise<JobStatusResponseBody> {
  for (let attemptNumber = 0; attemptNumber < 50; attemptNumber += 1) {
    const response = await request(application.getHttpServer())
      .get(`/api/jobs/${jobId}`)
      .expect(200);
    const jobDetails = parseJobStatusResponse(response.body as unknown);
    if (jobDetails.status === expectedStatus) return jobDetails;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Job ${jobId} did not reach status ${expectedStatus}`);
}

function parseCreateJobResponse(responseBody: unknown): CreateJobResponseBody {
  if (!isRecord(responseBody) || typeof responseBody.jobId !== 'string') {
    throw new Error('Create-job response did not match its contract');
  }
  return { jobId: responseBody.jobId };
}

function parseJobStatusResponse(responseBody: unknown): JobStatusResponseBody {
  if (
    !isRecord(responseBody) ||
    typeof responseBody.createdAt !== 'string' ||
    typeof responseBody.id !== 'string' ||
    typeof responseBody.status !== 'string' ||
    !Array.isArray(responseBody.urlChecks) ||
    !responseBody.urlChecks.every(isUrlCheckResponse)
  ) {
    throw new Error('Job-detail response did not match its contract');
  }

  return {
    createdAt: responseBody.createdAt,
    id: responseBody.id,
    status: responseBody.status,
    urlChecks: responseBody.urlChecks,
  };
}

function isUrlCheckResponse(value: unknown): value is UrlCheckResponseBody {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    typeof value.url === 'string' &&
    isOptionalString(value.completedAt) &&
    isOptionalNumber(value.durationMs) &&
    isOptionalString(value.errorMessage) &&
    isOptionalNumber(value.httpStatus) &&
    isOptionalString(value.startedAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}
