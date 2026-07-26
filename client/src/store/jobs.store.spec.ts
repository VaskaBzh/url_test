import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelJob, createJob, getJob, getJobs } from '../api/jobs.api';
import { createDeferredPromise } from '../test/deferred';
import { createJobDetails, createJobSummary, createUrlCheck } from '../test/jobs.fixtures';
import { useJobsStore } from './jobs.store';

vi.mock('../api/jobs.api', () => ({
  cancelJob: vi.fn(),
  createJob: vi.fn(),
  getJob: vi.fn(),
  getJobs: vi.fn(),
}));

const mockedCancelJob = vi.mocked(cancelJob);
const mockedCreateJob = vi.mocked(createJob);
const mockedGetJob = vi.mocked(getJob);
const mockedGetJobs = vi.mocked(getJobs);

describe('useJobsStore core actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
    mockedCancelJob.mockResolvedValue(undefined);
    mockedCreateJob.mockResolvedValue({ jobId: 'created-job' });
    mockedGetJob.mockResolvedValue(createJobDetails({ id: 'created-job', status: 'completed' }));
    mockedGetJobs.mockResolvedValue([]);
  });

  it('exposes loading state until job summaries resolve', async () => {
    const store = useJobsStore();
    const jobsRequest = createDeferredPromise<ReturnType<typeof createJobSummary>[]>();
    const summary = createJobSummary();
    mockedGetJobs.mockReturnValue(jobsRequest.promise);

    const loadingPromise = store.loadJobs();

    expect(store.isLoadingJobs).toBe(true);
    jobsRequest.resolve([summary]);
    await loadingPromise;

    expect(store.jobs).toEqual([summary]);
    expect(store.isLoadingJobs).toBe(false);
  });

  it.each([
    { reason: new Error('Job list is unavailable.'), expectedMessage: 'Job list is unavailable.' },
    { reason: 'unstructured failure', expectedMessage: 'Unable to complete the request.' },
  ])('records a safe error when loading jobs rejects with $reason', async ({ reason, expectedMessage }) => {
    const store = useJobsStore();
    mockedGetJobs.mockRejectedValue(reason);

    await store.loadJobs();

    expect(store.errorMessage).toBe(expectedMessage);
    expect(store.isLoadingJobs).toBe(false);
  });

  it('rejects whitespace-only submission without calling the API', async () => {
    const store = useJobsStore();

    const wasSubmitted = await store.submitJob('  \n\t  ');

    expect(wasSubmitted).toBe(false);
    expect(store.errorMessage).toBe('Enter at least one URL.');
    expect(store.isSubmitting).toBe(false);
    expect(mockedCreateJob).not.toHaveBeenCalled();
  });

  it('normalizes non-empty lines and selects the created job', async () => {
    const store = useJobsStore();
    const createdDetails = createJobDetails({ id: 'created-job', status: 'completed' });
    mockedGetJob.mockResolvedValue(createdDetails);
    mockedGetJobs.mockResolvedValue([createJobSummary({ id: 'created-job', status: 'completed' })]);

    const wasSubmitted = await store.submitJob(' https://one.example \n\nhttps://one.example\n https://two.example ');

    expect(wasSubmitted).toBe(true);
    expect(mockedCreateJob).toHaveBeenCalledWith([
      'https://one.example',
      'https://one.example',
      'https://two.example',
    ]);
    expect(store.activeJobId).toBe('created-job');
    expect(store.activeJob).toEqual(createdDetails);
    expect(store.isSubmitting).toBe(false);
    expect(store.errorMessage).toBeNull();
  });

  it('returns false and resets submission state when creation fails', async () => {
    const store = useJobsStore();
    const creationRequest = createDeferredPromise<{ jobId: string }>();
    mockedCreateJob.mockReturnValue(creationRequest.promise);

    const submissionPromise = store.submitJob('https://example.com');

    expect(store.isSubmitting).toBe(true);
    creationRequest.reject(new Error('Creation failed.'));

    await expect(submissionPromise).resolves.toBe(false);
    expect(store.errorMessage).toBe('Creation failed.');
    expect(store.isSubmitting).toBe(false);
  });

  it('derives completed URL count and cancellation availability from active details', () => {
    const store = useJobsStore();
    store.activeJob = createJobDetails({
      status: 'in_progress',
      urlChecks: [
        createUrlCheck({ status: 'success' }),
        createUrlCheck({ status: 'error' }),
        createUrlCheck({ status: 'cancelled' }),
        createUrlCheck({ status: 'pending' }),
      ],
    });

    expect(store.completedUrlCount).toBe(3);
    expect(store.canCancelActiveJob).toBe(true);

    store.activeJob = createJobDetails({ status: 'completed' });
    expect(store.canCancelActiveJob).toBe(false);

    store.activeJob = null;
    expect(store.completedUrlCount).toBe(0);
    expect(store.canCancelActiveJob).toBe(false);
  });

  it('does not call cancellation API without an active job', async () => {
    const store = useJobsStore();

    await store.cancelActiveJob();

    expect(mockedCancelJob).not.toHaveBeenCalled();
    expect(store.isCancelling).toBe(false);
  });

  it('keeps cancellation state until the active job is refreshed', async () => {
    const store = useJobsStore();
    const cancellationRequest = createDeferredPromise<void>();
    const cancelledDetails = createJobDetails({ id: 'job-1', status: 'cancelled' });
    store.activeJobId = 'job-1';
    store.activeJob = createJobDetails({ id: 'job-1', status: 'in_progress' });
    mockedCancelJob.mockReturnValue(cancellationRequest.promise);
    mockedGetJob.mockResolvedValue(cancelledDetails);

    const cancellationPromise = store.cancelActiveJob();

    expect(store.isCancelling).toBe(true);
    cancellationRequest.resolve(undefined);
    await cancellationPromise;

    expect(mockedCancelJob).toHaveBeenCalledWith('job-1');
    expect(store.activeJob).toEqual(cancelledDetails);
    expect(store.isCancelling).toBe(false);
  });

  it('records cancellation errors and always resets cancellation state', async () => {
    const store = useJobsStore();
    store.activeJobId = 'job-1';
    mockedCancelJob.mockRejectedValue(new Error('Cancellation failed.'));

    await store.cancelActiveJob();

    expect(store.errorMessage).toBe('Cancellation failed.');
    expect(store.isCancelling).toBe(false);
  });
});
describe('useJobsStore polling isolation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
    vi.useFakeTimers();
    mockedGetJobs.mockResolvedValue([]);
  });

  afterEach(() => {
    useJobsStore().stopPolling();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('polls after 1500 ms and stops after receiving terminal details', async () => {
    const store = useJobsStore();
    mockedGetJob
      .mockResolvedValueOnce(createJobDetails({ id: 'job-1', status: 'in_progress' }))
      .mockResolvedValueOnce(createJobDetails({ id: 'job-1', status: 'completed' }));

    await store.selectJob('job-1');
    expect(mockedGetJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(mockedGetJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockedGetJob).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(mockedGetJob).toHaveBeenCalledTimes(2);
    expect(store.activeJob?.status).toBe('completed');
  });

  it('cancels the pending poll when stopPolling is called', async () => {
    const store = useJobsStore();
    mockedGetJob.mockResolvedValue(createJobDetails({ id: 'job-1', status: 'in_progress' }));

    await store.selectJob('job-1');
    store.stopPolling();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(mockedGetJob).toHaveBeenCalledTimes(1);
  });

  it('ignores details that resolve after a newer job is selected', async () => {
    const store = useJobsStore();
    const firstDetailsRequest = createDeferredPromise<ReturnType<typeof createJobDetails>>();
    const secondDetailsRequest = createDeferredPromise<ReturnType<typeof createJobDetails>>();
    mockedGetJob.mockImplementation((jobId) => {
      return jobId === 'job-a' ? firstDetailsRequest.promise : secondDetailsRequest.promise;
    });

    const firstSelectionPromise = store.selectJob('job-a');
    const secondSelectionPromise = store.selectJob('job-b');
    const secondDetails = createJobDetails({ id: 'job-b', status: 'completed' });
    secondDetailsRequest.resolve(secondDetails);
    await secondSelectionPromise;

    firstDetailsRequest.resolve(createJobDetails({ id: 'job-a', status: 'in_progress' }));
    await firstSelectionPromise;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(store.activeJobId).toBe('job-b');
    expect(store.activeJob).toEqual(secondDetails);
    expect(store.isLoadingDetails).toBe(false);
    expect(mockedGetJob).toHaveBeenCalledTimes(2);
  });

  it('does not schedule an obsolete poll after an older list refresh resolves', async () => {
    const store = useJobsStore();
    const firstListRequest = createDeferredPromise<ReturnType<typeof createJobSummary>[]>();
    mockedGetJob.mockImplementation((jobId) => {
      return Promise.resolve(createJobDetails({
        id: jobId,
        status: jobId === 'job-a' ? 'in_progress' : 'completed',
      }));
    });
    mockedGetJobs
      .mockImplementationOnce(() => firstListRequest.promise)
      .mockResolvedValue([]);

    const firstSelectionPromise = store.selectJob('job-a');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedGetJobs).toHaveBeenCalledTimes(1);

    await store.selectJob('job-b');
    firstListRequest.resolve([]);
    await firstSelectionPromise;
    await vi.advanceTimersByTimeAsync(1_500);

    expect(store.activeJobId).toBe('job-b');
    expect(store.activeJob?.id).toBe('job-b');
    expect(store.isLoadingDetails).toBe(false);
    expect(mockedGetJob).toHaveBeenCalledTimes(2);
  });

  it('records polling errors without leaving details loading', async () => {
    const store = useJobsStore();
    mockedGetJob.mockRejectedValue(new Error('Polling failed.'));

    await store.selectJob('job-1');

    expect(store.errorMessage).toBe('Polling failed.');
    expect(store.isLoadingDetails).toBe(false);
  });
});
