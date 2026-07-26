import { BadRequestException, Logger } from '@nestjs/common';
import type { HeadRequestOutcome } from './jobs.types';
import { HeadRequestService } from './head-request.service';
import { JobsService } from './jobs.service';
import type { ResultDelayService } from './result-delay.service';

interface DeferredPromise<Value> {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferredPromise<Value>(): DeferredPromise<Value> {
  let resolvePromise!: (value: Value | PromiseLike<Value>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function createUrlList(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `https://${prefix}.example/${index + 1}`,
  );
}

async function flushAsynchronousWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForJobStatus(
  jobsService: JobsService,
  jobId: string,
  expectedStatus:
    'completed' | 'cancelled' | 'failed' | 'in_progress' | 'pending',
): Promise<void> {
  for (let attemptNumber = 0; attemptNumber < 20; attemptNumber += 1) {
    if (jobsService.findOne(jobId).status === expectedStatus) return;
    await flushAsynchronousWork();
  }

  throw new Error(
    `Job ${jobId} did not reach expected status ${expectedStatus}`,
  );
}

describe('JobsService merged processing boundaries', () => {
  let jobsService: JobsService;
  let headRequestService: HeadRequestService;
  let resultDelayService: ResultDelayService;
  let headRequestCheck: jest.SpiedFunction<HeadRequestService['check']>;
  let resultDelayWait: jest.SpiedFunction<ResultDelayService['wait']>;
  let warningLogger: jest.SpyInstance;
  let errorLogger: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warningLogger = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorLogger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    headRequestService = {
      check: () => Promise.resolve({ kind: 'success', httpStatus: 200 }),
    } as HeadRequestService;
    resultDelayService = {
      wait: () => Promise.resolve(undefined),
    } as ResultDelayService;
    headRequestCheck = jest.spyOn(headRequestService, 'check');
    resultDelayWait = jest
      .spyOn(resultDelayService, 'wait')
      .mockResolvedValue(undefined);
    jobsService = new JobsService(headRequestService, resultDelayService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects jobs that exceed the per-job URL limit', () => {
    const urls = Array.from(
      { length: 51 },
      (_, index) => `https://example-${index}.com`,
    );

    expect(() => jobsService.create(urls)).toThrow(BadRequestException);
  });

  it('limits each job to five active checks', async () => {
    const deferredRequests: DeferredPromise<HeadRequestOutcome>[] = [];
    let activeRequestCount = 0;
    let maximumActiveRequestCount = 0;

    headRequestCheck.mockImplementation(() => {
      activeRequestCount += 1;
      maximumActiveRequestCount = Math.max(
        maximumActiveRequestCount,
        activeRequestCount,
      );
      const deferredRequest = createDeferredPromise<HeadRequestOutcome>();
      deferredRequests.push(deferredRequest);
      return deferredRequest.promise.finally(() => {
        activeRequestCount -= 1;
      });
    });

    const { jobId } = jobsService.create(createUrlList('concurrency', 6));
    await flushAsynchronousWork();

    expect(headRequestCheck).toHaveBeenCalledTimes(5);
    expect(maximumActiveRequestCount).toBe(5);
    expect(jobsService.findOne(jobId).status).toBe('in_progress');

    deferredRequests[0].resolve({ kind: 'success', httpStatus: 200 });
    await flushAsynchronousWork();

    expect(headRequestCheck).toHaveBeenCalledTimes(6);
    expect(maximumActiveRequestCount).toBe(5);
  });

  it('allows one job to complete while another job is blocked', async () => {
    const blockedRequest = createDeferredPromise<HeadRequestOutcome>();
    const blockedJobUrl = 'https://blocked.example/1';

    headRequestCheck.mockImplementation((url) =>
      url === blockedJobUrl
        ? blockedRequest.promise
        : Promise.resolve({ kind: 'success', httpStatus: 204 }),
    );

    const blockedJob = jobsService.create([blockedJobUrl]);
    const independentJob = jobsService.create([
      'https://independent.example/1',
    ]);

    await waitForJobStatus(jobsService, independentJob.jobId, 'completed');

    expect(jobsService.findOne(blockedJob.jobId).status).toBe('in_progress');
    expect(jobsService.findOne(independentJob.jobId)).toMatchObject({
      status: 'completed',
      urlChecks: [
        expect.objectContaining({ status: 'success', httpStatus: 204 }),
      ],
    });

    blockedRequest.resolve({ kind: 'success', httpStatus: 200 });
    await waitForJobStatus(jobsService, blockedJob.jobId, 'completed');
  });

  it('publishes a transport error only after the delay completes', async () => {
    const controlledDelay = createDeferredPromise<void>();
    headRequestCheck.mockResolvedValue({
      kind: 'error',
      errorMessage: 'Unable to reach URL.',
    });
    resultDelayWait.mockReturnValue(controlledDelay.promise);

    const { jobId } = jobsService.create(['https://delayed-error.example/1']);
    await flushAsynchronousWork();

    const delayedJob = jobsService.findOne(jobId);
    expect(delayedJob.status).toBe('in_progress');
    expect(delayedJob.urlChecks[0]).toMatchObject({ status: 'in_progress' });
    expect(delayedJob.urlChecks[0].errorMessage).toBeUndefined();
    expect(warningLogger).not.toHaveBeenCalled();

    controlledDelay.resolve(undefined);
    await waitForJobStatus(jobsService, jobId, 'completed');

    expect(jobsService.findOne(jobId).urlChecks[0]).toMatchObject({
      status: 'error',
      errorMessage: 'Unable to reach URL.',
    });
    expect(warningLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'url_check_transport_failed',
        jobId,
        errorType: 'transport',
      }),
    );
  });

  it('cancels pending checks without starting them later', async () => {
    const activeRequests: DeferredPromise<HeadRequestOutcome>[] = [];
    headRequestCheck.mockImplementation(() => {
      const activeRequest = createDeferredPromise<HeadRequestOutcome>();
      activeRequests.push(activeRequest);
      return activeRequest.promise;
    });

    const { jobId } = jobsService.create(createUrlList('cancellation', 6));
    await flushAsynchronousWork();

    expect(headRequestCheck).toHaveBeenCalledTimes(5);
    jobsService.cancel(jobId);

    const cancelledJob = jobsService.findOne(jobId);
    expect(cancelledJob.status).toBe('cancelled');
    expect(
      cancelledJob.urlChecks.filter(({ status }) => status === 'cancelled'),
    ).toHaveLength(1);

    for (const activeRequest of activeRequests) {
      activeRequest.resolve({ kind: 'success', httpStatus: 200 });
    }
    await waitForJobStatus(jobsService, jobId, 'cancelled');

    expect(headRequestCheck).toHaveBeenCalledTimes(5);
  });

  it('fails one job safely when the internal delay layer breaks', async () => {
    headRequestCheck.mockResolvedValue({ kind: 'success', httpStatus: 200 });
    resultDelayWait.mockRejectedValueOnce(
      new Error('Sensitive internal delay failure'),
    );

    const failedJobReference = jobsService.create(
      createUrlList('internal-failure', 2),
    );
    await waitForJobStatus(jobsService, failedJobReference.jobId, 'failed');

    const failedJob = jobsService.findOne(failedJobReference.jobId);
    expect(
      failedJob.urlChecks.some(
        ({ errorMessage }) => errorMessage === 'Internal job processing error',
      ),
    ).toBe(true);
    expect(
      failedJob.urlChecks.filter(({ status }) =>
        ['pending', 'in_progress'].includes(status),
      ),
    ).toHaveLength(0);
    expect(JSON.stringify(failedJob)).not.toContain('Sensitive internal');
    expect(errorLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'job_processing_failed',
        jobId: failedJobReference.jobId,
        failureStage: 'worker',
        errorName: 'Error',
      }),
      expect.stringContaining('Sensitive internal delay failure'),
    );
  });
});
