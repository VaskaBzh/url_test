import { Logger } from '@nestjs/common';
import { HeadRequestService } from './head-request.service';
import { JobsService } from './jobs.service';
import type { HeadRequestOutcome, JobStatus } from './jobs.types';
import { ResultDelayService } from './result-delay.service';

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
  expectedStatus: JobStatus,
): Promise<void> {
  for (let attemptNumber = 0; attemptNumber < 20; attemptNumber += 1) {
    if (jobsService.findOne(jobId).status === expectedStatus) return;
    await flushAsynchronousWork();
  }

  throw new Error(
    `Job ${jobId} did not reach expected status ${expectedStatus}`,
  );
}

async function waitForUrlChecksToFinish(
  jobsService: JobsService,
  jobId: string,
): Promise<void> {
  for (let attemptNumber = 0; attemptNumber < 20; attemptNumber += 1) {
    const hasNonterminalCheck = jobsService
      .findOne(jobId)
      .urlChecks.some(({ status }) =>
        ['pending', 'in_progress'].includes(status),
      );
    if (!hasNonterminalCheck) return;
    await flushAsynchronousWork();
  }

  throw new Error(`Job ${jobId} still has nonterminal URL checks`);
}
describe('JobsService asynchronous processing', () => {
  let jobsService: JobsService;
  let headRequestService: HeadRequestService;
  let resultDelayService: ResultDelayService;
  let headRequestCheck: jest.SpiedFunction<HeadRequestService['check']>;
  let resultDelayWait: jest.SpiedFunction<ResultDelayService['wait']>;
  let debugLogger: jest.SpyInstance;
  let infoLogger: jest.SpyInstance;
  let warningLogger: jest.SpyInstance;
  let errorLogger: jest.SpyInstance;

  beforeEach(() => {
    debugLogger = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    infoLogger = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warningLogger = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorLogger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    headRequestService = new HeadRequestService();
    resultDelayService = new ResultDelayService();
    headRequestCheck = jest.spyOn(headRequestService, 'check');
    resultDelayWait = jest
      .spyOn(resultDelayService, 'wait')
      .mockResolvedValue(undefined);
    jobsService = new JobsService(headRequestService, resultDelayService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

    expect(headRequestCheck).toHaveBeenCalledTimes(5);
    expect(maximumActiveRequestCount).toBe(5);
    expect(jobsService.findOne(jobId).status).toBe('in_progress');

    deferredRequests[0].resolve({ kind: 'success', httpStatus: 200 });
    await flushAsynchronousWork();

    expect(headRequestCheck).toHaveBeenCalledTimes(6);
    expect(maximumActiveRequestCount).toBe(5);

    for (const deferredRequest of deferredRequests.slice(1)) {
      deferredRequest.resolve({ kind: 'success', httpStatus: 200 });
    }
    await waitForJobStatus(jobsService, jobId, 'completed');

    expect(jobsService.findOne(jobId).urlChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'success', httpStatus: 200 }),
      ]),
    );
    expect(resultDelayWait).toHaveBeenCalledTimes(6);
    expect(debugLogger).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'job_processing_started', jobId }),
    );
    expect(debugLogger).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'job_worker_check_started', jobId }),
    );
    expect(debugLogger).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'job_processing_completed', jobId }),
    );
    expect(warningLogger).not.toHaveBeenCalled();
    expect(errorLogger).not.toHaveBeenCalled();
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

    const jobSummaries = jobsService.findAll();
    expect(jobSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: blockedJob.jobId,
          totalUrls: 1,
          successfulUrls: 1,
          errorUrls: 0,
        }),
        expect.objectContaining({
          id: independentJob.jobId,
          totalUrls: 1,
          successfulUrls: 1,
          errorUrls: 0,
        }),
      ]),
    );
    expect(warningLogger).not.toHaveBeenCalled();
    expect(errorLogger).not.toHaveBeenCalled();
  });
  it('publishes a successful result only after the delay completes', async () => {
    const controlledDelay = createDeferredPromise<void>();
    headRequestCheck.mockResolvedValue({ kind: 'success', httpStatus: 201 });
    resultDelayWait.mockReturnValue(controlledDelay.promise);

    const { jobId } = jobsService.create(['https://delayed-success.example/1']);
    await flushAsynchronousWork();

    const delayedJob = jobsService.findOne(jobId);
    expect(delayedJob.status).toBe('in_progress');
    expect(delayedJob.urlChecks[0]).toMatchObject({ status: 'in_progress' });
    expect(delayedJob.urlChecks[0].httpStatus).toBeUndefined();
    expect(delayedJob.urlChecks[0].errorMessage).toBeUndefined();
    expect(delayedJob.urlChecks[0].completedAt).toBeUndefined();
    expect(delayedJob.urlChecks[0].durationMs).toBeUndefined();
    expect(debugLogger).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'url_check_result_published', jobId }),
    );

    controlledDelay.resolve(undefined);
    await waitForJobStatus(jobsService, jobId, 'completed');

    const completedUrlCheck = jobsService.findOne(jobId).urlChecks[0];
    expect(completedUrlCheck).toMatchObject({
      status: 'success',
      httpStatus: 201,
    });
    expect(typeof completedUrlCheck.completedAt).toBe('string');
    expect(typeof completedUrlCheck.durationMs).toBe('number');
    expect(debugLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'url_check_result_published',
        jobId,
        state: 'success',
      }),
    );
  });

  it('publishes a transport error only after the delay completes', async () => {
    const controlledDelay = createDeferredPromise<void>();
    headRequestCheck.mockResolvedValue({
      kind: 'error',
      errorMessage: 'HEAD request failed (ECONNREFUSED)',
    });
    resultDelayWait.mockReturnValue(controlledDelay.promise);

    const { jobId } = jobsService.create(['https://delayed-error.example/1']);
    await flushAsynchronousWork();

    const delayedJob = jobsService.findOne(jobId);
    expect(delayedJob.status).toBe('in_progress');
    expect(delayedJob.urlChecks[0]).toMatchObject({ status: 'in_progress' });
    expect(delayedJob.urlChecks[0].httpStatus).toBeUndefined();
    expect(delayedJob.urlChecks[0].errorMessage).toBeUndefined();
    expect(warningLogger).not.toHaveBeenCalled();

    controlledDelay.resolve(undefined);
    await waitForJobStatus(jobsService, jobId, 'completed');

    const completedUrlCheck = jobsService.findOne(jobId).urlChecks[0];
    expect(completedUrlCheck).toMatchObject({
      status: 'error',
      errorMessage: 'HEAD request failed (ECONNREFUSED)',
    });
    expect(typeof completedUrlCheck.completedAt).toBe('string');
    expect(typeof completedUrlCheck.durationMs).toBe('number');
    expect(warningLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'url_check_transport_failed',
        jobId,
        errorType: 'transport',
      }),
    );
    expect(debugLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'url_check_result_published',
        jobId,
        state: 'error',
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

    expect(headRequestCheck).toHaveBeenCalledTimes(5);
    jobsService.cancel(jobId);
    jobsService.cancel(jobId);

    const cancelledJob = jobsService.findOne(jobId);
    expect(cancelledJob.status).toBe('cancelled');
    expect(
      cancelledJob.urlChecks.filter(({ status }) => status === 'in_progress'),
    ).toHaveLength(5);
    expect(
      cancelledJob.urlChecks.filter(({ status }) => status === 'cancelled'),
    ).toHaveLength(1);
    expect(infoLogger).toHaveBeenCalledTimes(1);
    expect(infoLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'job_cancelled',
        jobId,
        cancelledUrlCount: 1,
      }),
    );

    for (const activeRequest of activeRequests) {
      activeRequest.resolve({ kind: 'success', httpStatus: 200 });
    }
    await waitForUrlChecksToFinish(jobsService, jobId);

    const finishedCancelledJob = jobsService.findOne(jobId);
    expect(finishedCancelledJob.status).toBe('cancelled');
    expect(headRequestCheck).toHaveBeenCalledTimes(5);
    expect(
      finishedCancelledJob.urlChecks.filter(
        ({ status }) => status === 'success',
      ),
    ).toHaveLength(5);
    expect(
      finishedCancelledJob.urlChecks.filter(
        ({ status }) => status === 'cancelled',
      ),
    ).toHaveLength(1);
    expect(debugLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'job_worker_stopped',
        jobId,
        reason: 'job_cancelled',
      }),
    );
    expect(warningLogger).not.toHaveBeenCalled();
    expect(errorLogger).not.toHaveBeenCalled();
  });
  it('fails one job safely without affecting an independent job', async () => {
    const blockedRequests: DeferredPromise<HeadRequestOutcome>[] = [];
    headRequestCheck.mockImplementation((url) => {
      if (url.endsWith('/1')) {
        return Promise.resolve({ kind: 'success', httpStatus: 200 });
      }

      const blockedRequest = createDeferredPromise<HeadRequestOutcome>();
      blockedRequests.push(blockedRequest);
      return blockedRequest.promise;
    });
    resultDelayWait.mockRejectedValueOnce(
      new Error('Sensitive internal delay failure'),
    );

    const failedJobReference = jobsService.create(
      createUrlList('internal-failure', 6),
    );
    await waitForJobStatus(jobsService, failedJobReference.jobId, 'failed');

    const failedJob = jobsService.findOne(failedJobReference.jobId);
    expect(failedJob.urlChecks).toHaveLength(6);
    expect(failedJob.urlChecks.every(({ status }) => status === 'error')).toBe(
      true,
    );
    expect(
      failedJob.urlChecks.every(
        ({ errorMessage }) => errorMessage === 'Internal job processing error',
      ),
    ).toBe(true);
    expect(JSON.stringify(failedJob)).not.toContain('Sensitive internal');
    expect(errorLogger).toHaveBeenCalledTimes(1);
    expect(errorLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'job_processing_failed',
        jobId: failedJobReference.jobId,
        failureStage: 'worker',
        errorName: 'Error',
      }),
      expect.stringContaining('Sensitive internal delay failure'),
    );
    expect(debugLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'url_check_terminalized_after_failure',
        jobId: failedJobReference.jobId,
      }),
    );

    for (const blockedRequest of blockedRequests) {
      blockedRequest.resolve({ kind: 'success', httpStatus: 200 });
    }
    await flushAsynchronousWork();

    expect(
      jobsService
        .findOne(failedJobReference.jobId)
        .urlChecks.every(({ status }) => status === 'error'),
    ).toBe(true);

    headRequestCheck.mockResolvedValue({ kind: 'success', httpStatus: 204 });
    resultDelayWait.mockResolvedValue(undefined);
    const independentJobReference = jobsService.create([
      'https://healthy-after-failure.example/1',
    ]);
    await waitForJobStatus(
      jobsService,
      independentJobReference.jobId,
      'completed',
    );

    expect(jobsService.findOne(independentJobReference.jobId)).toMatchObject({
      status: 'completed',
      urlChecks: [
        expect.objectContaining({ status: 'success', httpStatus: 204 }),
      ],
    });
    expect(errorLogger).toHaveBeenCalledTimes(1);
  });

  it('keeps a cancelled job cancelled after a late internal failure', async () => {
    const controlledRequest = createDeferredPromise<HeadRequestOutcome>();
    headRequestCheck.mockReturnValue(controlledRequest.promise);
    resultDelayWait.mockRejectedValue(
      new Error('Sensitive cancelled job failure'),
    );

    const { jobId } = jobsService.create([
      'https://cancelled-internal-failure.example/1',
    ]);
    jobsService.cancel(jobId);
    controlledRequest.resolve({ kind: 'success', httpStatus: 200 });
    await waitForUrlChecksToFinish(jobsService, jobId);

    const cancelledJob = jobsService.findOne(jobId);
    expect(cancelledJob.status).toBe('cancelled');
    expect(cancelledJob.urlChecks[0]).toMatchObject({
      status: 'error',
      errorMessage: 'Internal job processing error',
    });
    expect(typeof cancelledJob.urlChecks[0].completedAt).toBe('string');
    expect(JSON.stringify(cancelledJob)).not.toContain('Sensitive cancelled');
    expect(errorLogger).not.toHaveBeenCalled();
    expect(warningLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'job_processing_failure_after_cancellation',
        jobId,
        failureStage: 'worker',
        errorName: 'Error',
      }),
    );
    expect(debugLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'url_check_terminalized_after_failure',
        jobId,
        nextState: 'error',
      }),
    );
  });
});
