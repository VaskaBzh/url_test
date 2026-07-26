import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { cancelJob, createJob, getJob, getJobs, isAbortError } from '../api/jobs.api';
import type { JobDetails, JobStatus, JobSummary, UrlCheckStatus } from '../types';
import { logWorkflowError } from '../utils/workflow.logger';

const POLL_INTERVAL_MILLISECONDS = 1_500;
const TERMINAL_STATUSES: JobStatus[] = ['completed', 'cancelled', 'failed'];
const TERMINAL_URL_STATUSES: UrlCheckStatus[] = ['success', 'error', 'cancelled'];

/**
 * Owns the job list and active job state. Request generations prevent obsolete
 * asynchronous work from mutating a newer user selection.
 */
export const useJobsStore = defineStore('jobs', () => {
  const jobs = ref<JobSummary[]>([]);
  const activeJobId = ref<string | null>(null);
  const activeJob = ref<JobDetails | null>(null);
  const isLoadingJobs = ref(false);
  const isLoadingDetails = ref(false);
  const isSubmitting = ref(false);
  const cancellingJobId = ref<string | null>(null);
  const listErrorMessage = ref<string | null>(null);
  const detailsErrorMessage = ref<string | null>(null);
  const submissionErrorMessage = ref<string | null>(null);
  const cancellationErrorMessage = ref<string | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let selectionGeneration = 0;
  let detailRequestGeneration = 0;
  let detailAbortController: AbortController | null = null;
  let listRequestGeneration = 0;
  let listAbortController: AbortController | null = null;

  const completedUrlCount = computed(
    () => activeJob.value?.urlChecks.filter(({ status }) => TERMINAL_URL_STATUSES.includes(status)).length ?? 0,
  );
  const isCancelling = computed(
    () => activeJobId.value !== null && cancellingJobId.value === activeJobId.value,
  );
  const canCancelActiveJob = computed(
    () => activeJob.value !== null
      && cancellingJobId.value === null
      && !TERMINAL_STATUSES.includes(activeJob.value.status),
  );
  const errorMessage = computed(
    () => submissionErrorMessage.value
      ?? cancellationErrorMessage.value
      ?? detailsErrorMessage.value
      ?? listErrorMessage.value,
  );

  /** Fetches the latest job summaries without changing the current selection. */
  async function loadJobs(): Promise<void> {
    const requestGeneration = startListRequest();
    const abortController = listAbortController;
    isLoadingJobs.value = true;
    listErrorMessage.value = null;

    try {
      const summaries = await getJobs(abortController?.signal);
      if (!isCurrentListRequest(requestGeneration)) return;
      jobs.value = summaries;
    } catch (error) {
      if (isAbortError(error) || !isCurrentListRequest(requestGeneration)) return;
      listErrorMessage.value = toErrorMessage(error);
      logWorkflowError('loadJobs', error);
    } finally {
      if (isCurrentListRequest(requestGeneration)) {
        isLoadingJobs.value = false;
        listAbortController = null;
      }
    }
  }

  /** Selects a job and starts a polling cycle for it if it remains active. */
  async function selectJob(jobId: string): Promise<void> {
    stopPolling();
    activeJobId.value = jobId;
    activeJob.value = null;
    detailsErrorMessage.value = null;
    cancellationErrorMessage.value = null;
    await loadDetails(jobId);
  }

  /** Submits valid textarea content without overriding a later manual selection. */
  async function submitJob(textareaValue: string): Promise<boolean> {
    if (isSubmitting.value) return false;

    const urls = textareaValue.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    if (!urls.length) {
      submissionErrorMessage.value = 'Enter at least one URL.';
      return false;
    }

    const selectionGenerationAtSubmission = selectionGeneration;
    isSubmitting.value = true;
    submissionErrorMessage.value = null;

    try {
      const { jobId } = await createJob(urls);
      if (selectionGeneration === selectionGenerationAtSubmission) {
        await selectJob(jobId);
      } else {
        await loadJobs();
      }
      return true;
    } catch (error) {
      submissionErrorMessage.value = toErrorMessage(error);
      logWorkflowError('submitJob', error);
      return false;
    } finally {
      isSubmitting.value = false;
    }
  }

  /** Cancels the job captured at invocation without mutating a later selection. */
  async function cancelActiveJob(): Promise<void> {
    const jobId = activeJobId.value;
    if (!jobId || cancellingJobId.value !== null) return;

    const selectionGenerationAtCancellation = selectionGeneration;
    cancellingJobId.value = jobId;
    cancellationErrorMessage.value = null;

    try {
      await cancelJob(jobId);
      await loadJobs();
      if (isSelectionCurrent(jobId, selectionGenerationAtCancellation)) {
        await loadDetails(jobId);
      }
    } catch (error) {
      if (!isSelectionCurrent(jobId, selectionGenerationAtCancellation)) return;
      cancellationErrorMessage.value = toErrorMessage(error);
      logWorkflowError('cancelActiveJob', error, jobId);
    } finally {
      if (cancellingJobId.value === jobId) {
        cancellingJobId.value = null;
      }
    }
  }

  /** Invalidates scheduled and in-flight detail work for the active selection. */
  function stopPolling(): void {
    clearPollTimer();
    selectionGeneration += 1;
    detailRequestGeneration += 1;
    detailAbortController?.abort();
    detailAbortController = null;
    isLoadingDetails.value = false;
  }

  async function loadDetails(requestedJobId: string): Promise<void> {
    const requestGeneration = startDetailRequest();
    const abortController = detailAbortController;
    isLoadingDetails.value = true;
    detailsErrorMessage.value = null;

    try {
      const details = await getJob(requestedJobId, abortController?.signal);
      if (!isCurrentDetailRequest(requestedJobId, requestGeneration)) return;

      activeJob.value = details;
      await loadJobs();

      if (!isCurrentDetailRequest(requestedJobId, requestGeneration)) return;
      if (!TERMINAL_STATUSES.includes(details.status)) {
        schedulePoll(requestedJobId, requestGeneration);
      }
    } catch (error) {
      if (isAbortError(error) || !isCurrentDetailRequest(requestedJobId, requestGeneration)) return;
      detailsErrorMessage.value = toErrorMessage(error);
      logWorkflowError('loadDetails', error, requestedJobId);
    } finally {
      if (isCurrentDetailRequest(requestedJobId, requestGeneration)) {
        isLoadingDetails.value = false;
        detailAbortController = null;
      }
    }
  }

  function startDetailRequest(): number {
    clearPollTimer();
    detailAbortController?.abort();
    detailAbortController = new AbortController();
    detailRequestGeneration += 1;
    return detailRequestGeneration;
  }

  function startListRequest(): number {
    listAbortController?.abort();
    listAbortController = new AbortController();
    listRequestGeneration += 1;
    return listRequestGeneration;
  }

  function isCurrentDetailRequest(requestedJobId: string, requestGeneration: number): boolean {
    return activeJobId.value === requestedJobId && detailRequestGeneration === requestGeneration;
  }

  function isCurrentListRequest(requestGeneration: number): boolean {
    return listRequestGeneration === requestGeneration;
  }

  function isSelectionCurrent(jobId: string, requestSelectionGeneration: number): boolean {
    return activeJobId.value === jobId && selectionGeneration === requestSelectionGeneration;
  }

  function schedulePoll(requestedJobId: string, requestGeneration: number): void {
    clearPollTimer();
    pollTimer = setTimeout(() => {
      if (!isCurrentDetailRequest(requestedJobId, requestGeneration)) return;
      void loadDetails(requestedJobId);
    }, POLL_INTERVAL_MILLISECONDS);
  }

  function clearPollTimer(): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unable to complete the request.';
  }

  return {
    jobs,
    activeJobId,
    activeJob,
    isLoadingJobs,
    isLoadingDetails,
    isSubmitting,
    isCancelling,
    listErrorMessage,
    detailsErrorMessage,
    submissionErrorMessage,
    cancellationErrorMessage,
    errorMessage,
    completedUrlCount,
    canCancelActiveJob,
    loadJobs,
    selectJob,
    submitJob,
    cancelActiveJob,
    stopPolling,
  };
});