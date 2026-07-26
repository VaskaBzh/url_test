import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelJob, createJob, getJob, getJobs } from '../api/jobs.api';
import type { JobDetails, JobSummary } from '../types';
import { useJobsStore } from './jobs.store';

vi.mock('../api/jobs.api', () => ({
  cancelJob: vi.fn(),
  createJob: vi.fn(),
  getJob: vi.fn(),
  getJobs: vi.fn(),
  isAbortError: vi.fn((error: unknown) => error instanceof Error && error.name === 'AbortError'),
}));

interface DeferredPromise<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<Value>(): DeferredPromise<Value> {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createJobDetails(jobId: string): JobDetails {
  return {
    id: jobId,
    createdAt: '2026-07-26T10:00:00.000Z',
    status: 'completed',
    urlChecks: [],
  };
}

function createJobSummary(jobId: string): JobSummary {
  return {
    id: jobId,
    createdAt: '2026-07-26T10:00:00.000Z',
    status: 'completed',
    totalUrls: 0,
    successfulUrls: 0,
    errorUrls: 0,
  };
}

const mockedCancelJob = vi.mocked(cancelJob);
const mockedCreateJob = vi.mocked(createJob);
const mockedGetJob = vi.mocked(getJob);
const mockedGetJobs = vi.mocked(getJobs);

describe('jobs store workflow ownership', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockedGetJobs.mockResolvedValue([]);
  });

  it('keeps the newly selected job when an older request resolves later', async () => {
    const firstJobRequest = createDeferred<JobDetails>();
    const secondJobRequest = createDeferred<JobDetails>();
    mockedGetJob.mockImplementation((jobId) => jobId === 'job-a' ? firstJobRequest.promise : secondJobRequest.promise);
    const jobsStore = useJobsStore();

    const firstSelection = jobsStore.selectJob('job-a');
    const secondSelection = jobsStore.selectJob('job-b');
    secondJobRequest.resolve(createJobDetails('job-b'));
    await secondSelection;
    firstJobRequest.resolve(createJobDetails('job-a'));
    await firstSelection;

    expect(jobsStore.activeJob?.id).toBe('job-b');
    expect(jobsStore.isLoadingDetails).toBe(false);
  });

  it('rejects an obsolete same-id response after selecting A, B, then A', async () => {
    const firstJobRequest = createDeferred<JobDetails>();
    const secondJobRequest = createDeferred<JobDetails>();
    const thirdJobRequest = createDeferred<JobDetails>();
    mockedGetJob
      .mockReturnValueOnce(firstJobRequest.promise)
      .mockReturnValueOnce(secondJobRequest.promise)
      .mockReturnValueOnce(thirdJobRequest.promise);
    const jobsStore = useJobsStore();

    const firstSelection = jobsStore.selectJob('job-a');
    const secondSelection = jobsStore.selectJob('job-b');
    const thirdSelection = jobsStore.selectJob('job-a');
    firstJobRequest.resolve(createJobDetails('obsolete-job-a'));
    await firstSelection;

    expect(jobsStore.activeJob).toBeNull();
    expect(jobsStore.isLoadingDetails).toBe(true);

    thirdJobRequest.resolve(createJobDetails('job-a'));
    await thirdSelection;
    secondJobRequest.resolve(createJobDetails('job-b'));
    await secondSelection;

    expect(jobsStore.activeJob?.id).toBe('job-a');
    expect(jobsStore.isLoadingDetails).toBe(false);
  });

  it('does not expose or log an error from an obsolete details request', async () => {
    const firstJobRequest = createDeferred<JobDetails>();
    const secondJobRequest = createDeferred<JobDetails>();
    mockedGetJob.mockImplementation((jobId) => jobId === 'job-a' ? firstJobRequest.promise : secondJobRequest.promise);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const jobsStore = useJobsStore();

    const firstSelection = jobsStore.selectJob('job-a');
    const secondSelection = jobsStore.selectJob('job-b');
    secondJobRequest.resolve(createJobDetails('job-b'));
    await secondSelection;
    firstJobRequest.reject(new Error('obsolete failure'));
    await firstSelection;

    expect(jobsStore.detailsErrorMessage).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('keeps the latest list response when refreshes overlap', async () => {
    const firstListRequest = createDeferred<JobSummary[]>();
    const secondListRequest = createDeferred<JobSummary[]>();
    mockedGetJobs
      .mockReturnValueOnce(firstListRequest.promise)
      .mockReturnValueOnce(secondListRequest.promise);
    const jobsStore = useJobsStore();

    const firstRefresh = jobsStore.loadJobs();
    const secondRefresh = jobsStore.loadJobs();
    secondListRequest.resolve([createJobSummary('new-job')]);
    await secondRefresh;
    firstListRequest.resolve([createJobSummary('old-job')]);
    await firstRefresh;

    expect(jobsStore.jobs.map(({ id }) => id)).toEqual(['new-job']);
    expect(jobsStore.isLoadingJobs).toBe(false);
  });

  it('does not refresh or transfer cancellation state after selection changes', async () => {
    mockedGetJob.mockImplementation(async (jobId) => createJobDetails(jobId));
    const cancellationRequest = createDeferred<void>();
    mockedCancelJob.mockReturnValue(cancellationRequest.promise);
    const jobsStore = useJobsStore();
    await jobsStore.selectJob('job-a');

    const cancellation = jobsStore.cancelActiveJob();
    await jobsStore.selectJob('job-b');
    cancellationRequest.resolve(undefined);
    await cancellation;

    expect(jobsStore.activeJob?.id).toBe('job-b');
    expect(jobsStore.isCancelling).toBe(false);
    expect(jobsStore.cancellationErrorMessage).toBeNull();
    expect(mockedGetJob).toHaveBeenCalledTimes(2);
  });

  it('guards against duplicate submissions while the first request is pending', async () => {
    const creationRequest = createDeferred<{ jobId: string }>();
    mockedCreateJob.mockReturnValue(creationRequest.promise);
    mockedGetJob.mockResolvedValue(createJobDetails('created-job'));
    const jobsStore = useJobsStore();

    const firstSubmission = jobsStore.submitJob('https://example.com');
    const secondSubmission = jobsStore.submitJob('https://example.com');
    creationRequest.resolve({ jobId: 'created-job' });

    await expect(firstSubmission).resolves.toBe(true);
    await expect(secondSubmission).resolves.toBe(false);
    expect(mockedCreateJob).toHaveBeenCalledTimes(1);
  });

  it('logs one safe error for the current failed list request', async () => {
    mockedGetJobs.mockRejectedValue(new Error('response body must stay private'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const jobsStore = useJobsStore();

    await jobsStore.loadJobs();

    expect(jobsStore.listErrorMessage).toBe('response body must stay private');
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[workflow.loadJobs] Request failed',
      { jobId: undefined, errorName: 'Error' },
    );
  });
});