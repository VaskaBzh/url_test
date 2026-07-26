import type { Job, JobStatus, UrlCheck, UrlCheckStatus } from './jobs.types';

/** Generic message exposed when an unexpected processor failure terminalizes a URL. */
export const INTERNAL_PROCESSOR_ERROR_MESSAGE =
  'Job processing failed unexpectedly';

const JOB_STATUS_TRANSITIONS: Readonly<
  Record<JobStatus, readonly JobStatus[]>
> = {
  pending: ['in_progress', 'cancelled', 'failed'],
  in_progress: ['completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

const URL_CHECK_STATUS_TRANSITIONS: Readonly<
  Record<UrlCheckStatus, readonly UrlCheckStatus[]>
> = {
  pending: ['in_progress', 'cancelled', 'error'],
  in_progress: ['success', 'error'],
  success: [],
  error: [],
  cancelled: [],
};

const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'completed',
  'cancelled',
  'failed',
];
const TERMINAL_URL_CHECK_STATUSES: readonly UrlCheckStatus[] = [
  'success',
  'error',
  'cancelled',
];

/** Identifies the domain entity whose lifecycle transition was rejected. */
export type LifecycleEntityType = 'job' | 'url_check';

/** Error raised when domain state attempts a transition outside the lifecycle contract. */
export class InvalidLifecycleTransitionError extends Error {
  /** Captures transition context without exposing URL values or request payloads. */
  constructor(
    readonly entityType: LifecycleEntityType,
    readonly currentStatus: JobStatus | UrlCheckStatus,
    readonly requestedStatus: JobStatus | UrlCheckStatus,
    readonly reason?: string,
  ) {
    super(
      `Invalid ${entityType} transition from ${currentStatus} to ${requestedStatus}${
        reason ? `: ${reason}` : ''
      }`,
    );
    this.name = InvalidLifecycleTransitionError.name;
  }
}

/** Reports whether a job status prevents any further state transition. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** Reports whether a URL-check status prevents any further state transition. */
export function isTerminalUrlCheckStatus(status: UrlCheckStatus): boolean {
  return TERMINAL_URL_CHECK_STATUSES.includes(status);
}

/**
 * Applies one allowed job transition and returns whether state changed.
 *
 * Repeating the current status is an idempotent no-op. Completing a job before
 * every URL is terminal raises InvalidLifecycleTransitionError.
 */
export function transitionJobStatus(
  job: Job,
  requestedStatus: JobStatus,
): boolean {
  if (job.status === requestedStatus) return false;
  if (!JOB_STATUS_TRANSITIONS[job.status].includes(requestedStatus)) {
    throw new InvalidLifecycleTransitionError(
      'job',
      job.status,
      requestedStatus,
    );
  }
  if (
    ['completed', 'failed'].includes(requestedStatus) &&
    !job.urlChecks.every(({ status }) => isTerminalUrlCheckStatus(status))
  ) {
    throw new InvalidLifecycleTransitionError(
      'job',
      job.status,
      requestedStatus,
      'all URL checks must be terminal',
    );
  }
  if (
    requestedStatus === 'cancelled' &&
    job.urlChecks.some(({ status }) => status === 'pending')
  ) {
    throw new InvalidLifecycleTransitionError(
      'job',
      job.status,
      requestedStatus,
      'pending URL checks must be cancelled first',
    );
  }

  job.status = requestedStatus;
  return true;
}

/** Applies one allowed URL-check transition and returns whether state changed. */
export function transitionUrlCheckStatus(
  urlCheck: UrlCheck,
  requestedStatus: UrlCheckStatus,
): boolean {
  if (urlCheck.status === requestedStatus) return false;
  if (
    !URL_CHECK_STATUS_TRANSITIONS[urlCheck.status].includes(requestedStatus)
  ) {
    throw new InvalidLifecycleTransitionError(
      'url_check',
      urlCheck.status,
      requestedStatus,
    );
  }

  urlCheck.status = requestedStatus;
  return true;
}

/**
 * Cancels a non-terminal job and every URL that has not started.
 *
 * Terminal jobs are preserved so repeated DELETE requests remain idempotent.
 */
export function cancelJob(job: Job): number {
  if (isTerminalJobStatus(job.status)) return 0;

  let cancelledUrlCount = 0;
  for (const urlCheck of job.urlChecks) {
    if (urlCheck.status !== 'pending') continue;
    transitionUrlCheckStatus(urlCheck, 'cancelled');
    cancelledUrlCount += 1;
  }
  transitionJobStatus(job, 'cancelled');

  return cancelledUrlCount;
}

/**
 * Terminalizes an unexpectedly failed processor without overriding cancellation.
 *
 * Pending URL checks receive no synthetic timing. An in-progress check receives
 * completion timing only when its start timestamp is known.
 */
export function failJob(job: Job, completedAt: string): boolean {
  if (isTerminalJobStatus(job.status)) return false;

  for (const urlCheck of job.urlChecks) {
    if (isTerminalUrlCheckStatus(urlCheck.status)) continue;

    const previousStatus = urlCheck.status;
    transitionUrlCheckStatus(urlCheck, 'error');
    urlCheck.errorMessage = INTERNAL_PROCESSOR_ERROR_MESSAGE;
    if (previousStatus === 'in_progress' && urlCheck.startedAt) {
      urlCheck.completedAt = completedAt;
      const startedAtMilliseconds = Date.parse(urlCheck.startedAt);
      const completedAtMilliseconds = Date.parse(completedAt);
      if (
        Number.isFinite(startedAtMilliseconds) &&
        Number.isFinite(completedAtMilliseconds)
      ) {
        urlCheck.durationMs = Math.max(
          0,
          completedAtMilliseconds - startedAtMilliseconds,
        );
      }
    }
  }

  transitionJobStatus(job, 'failed');
  return true;
}
