import {
  cancelJob,
  failJob,
  INTERNAL_PROCESSOR_ERROR_MESSAGE,
  InvalidLifecycleTransitionError,
  isTerminalJobStatus,
  isTerminalUrlCheckStatus,
  transitionJobStatus,
  transitionUrlCheckStatus,
} from './jobs.lifecycle';
import type { Job, JobStatus, UrlCheck, UrlCheckStatus } from './jobs.types';

describe('job lifecycle', () => {
  it.each([
    ['pending', false],
    ['in_progress', false],
    ['completed', true],
    ['cancelled', true],
    ['failed', true],
  ] satisfies ReadonlyArray<readonly [JobStatus, boolean]>)(
    'reports whether %s is terminal',
    (status, expectedResult) => {
      expect(isTerminalJobStatus(status)).toBe(expectedResult);
    },
  );

  it('allows a job to complete only after every URL is terminal', () => {
    const job = createJob('in_progress', ['success', 'error']);

    expect(transitionJobStatus(job, 'completed')).toBe(true);
    expect(job.status).toBe('completed');
    expect(transitionJobStatus(job, 'completed')).toBe(false);
  });

  it('rejects completion while a URL remains non-terminal', () => {
    const job = createJob('in_progress', ['success', 'pending']);

    expect(() => transitionJobStatus(job, 'completed')).toThrow(
      InvalidLifecycleTransitionError,
    );
    expect(job.status).toBe('in_progress');
  });

  it('rejects a transition away from a terminal job status', () => {
    const job = createJob('completed', ['success']);

    expect(() => transitionJobStatus(job, 'failed')).toThrow(
      InvalidLifecycleTransitionError,
    );
    expect(job.status).toBe('completed');
  });
});

describe('URL-check lifecycle', () => {
  it.each([
    ['pending', 'in_progress'],
    ['pending', 'cancelled'],
    ['pending', 'error'],
    ['in_progress', 'success'],
    ['in_progress', 'error'],
  ] satisfies ReadonlyArray<readonly [UrlCheckStatus, UrlCheckStatus]>)(
    'allows %s to transition to %s',
    (currentStatus, requestedStatus) => {
      const urlCheck = createUrlCheck(currentStatus);

      expect(transitionUrlCheckStatus(urlCheck, requestedStatus)).toBe(true);
      expect(urlCheck.status).toBe(requestedStatus);
    },
  );

  it.each([
    'success',
    'error',
    'cancelled',
  ] satisfies readonly UrlCheckStatus[])(
    'keeps terminal status %s immutable',
    (status) => {
      const urlCheck = createUrlCheck(status);

      expect(isTerminalUrlCheckStatus(status)).toBe(true);
      expect(() => transitionUrlCheckStatus(urlCheck, 'in_progress')).toThrow(
        InvalidLifecycleTransitionError,
      );
      expect(urlCheck.status).toBe(status);
    },
  );
});

describe('job terminalization helpers', () => {
  it('cancels pending URLs and preserves an in-progress URL', () => {
    const job = createJob('in_progress', ['pending', 'in_progress', 'success']);

    expect(cancelJob(job)).toBe(1);
    expect(job.status).toBe('cancelled');
    expect(job.urlChecks.map(({ status }) => status)).toEqual([
      'cancelled',
      'in_progress',
      'success',
    ]);
    expect(cancelJob(job)).toBe(0);
  });

  it('terminalizes failed URLs without inventing timing for pending work', () => {
    const completedAt = '2026-07-26T12:00:01.000Z';
    const job = createJob('in_progress', ['pending', 'in_progress', 'success']);
    job.urlChecks[1].startedAt = '2026-07-26T12:00:00.000Z';

    expect(failJob(job, completedAt)).toBe(true);
    expect(job.status).toBe('failed');
    expect(job.urlChecks[0]).toEqual({
      errorMessage: INTERNAL_PROCESSOR_ERROR_MESSAGE,
      status: 'error',
      url: 'http://localhost/0',
    });
    expect(job.urlChecks[1]).toEqual({
      completedAt,
      durationMs: 1_000,
      errorMessage: INTERNAL_PROCESSOR_ERROR_MESSAGE,
      startedAt: '2026-07-26T12:00:00.000Z',
      status: 'error',
      url: 'http://localhost/1',
    });
    expect(job.urlChecks[2]).toEqual({
      status: 'success',
      url: 'http://localhost/2',
    });
  });

  it('does not overwrite cancellation with a late processor failure', () => {
    const job = createJob('in_progress', ['pending']);
    cancelJob(job);

    expect(failJob(job, '2026-07-26T12:00:00.000Z')).toBe(false);
    expect(job.status).toBe('cancelled');
    expect(job.urlChecks[0].status).toBe('cancelled');
  });
});

function createJob(
  status: JobStatus,
  urlStatuses: readonly UrlCheckStatus[],
): Job {
  return {
    createdAt: '2026-07-26T12:00:00.000Z',
    id: 'job-id',
    status,
    urlChecks: urlStatuses.map((urlStatus, urlIndex) => ({
      status: urlStatus,
      url: `http://localhost/${urlIndex}`,
    })),
  };
}

function createUrlCheck(status: UrlCheckStatus): UrlCheck {
  return { status, url: 'http://localhost' };
}
