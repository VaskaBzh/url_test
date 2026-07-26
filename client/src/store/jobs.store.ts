import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { cancelJob, createJob, getJob, getJobs } from '../api/jobs.api';
import type { JobDetails, JobStatus, JobSummary, UrlCheckStatus } from '../types';

const POLL_INTERVAL_MS = 1_500;
const TERMINAL_STATUSES: JobStatus[] = ['completed', 'cancelled', 'failed'];
const TERMINAL_URL_STATUSES: UrlCheckStatus[] = ['success', 'error', 'cancelled'];

/**
 * Owns the job list and active job state. Each poll checks its id before committing
 * a response, so a late request can never overwrite a newly selected job.
 */
export const useJobsStore = defineStore('jobs', () => {
  const jobs = ref<JobSummary[]>([]);
  const activeJobId = ref<string | null>(null);
  const activeJob = ref<JobDetails | null>(null);
  const isLoadingJobs = ref(false);
  const isLoadingDetails = ref(false);
  const isSubmitting = ref(false);
  const isCancelling = ref(false);
  const errorMessage = ref<string | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const completedUrlCount = computed(() => activeJob.value?.urlChecks.filter(({ status }) => TERMINAL_URL_STATUSES.includes(status)).length ?? 0);
  const canCancelActiveJob = computed(() => activeJob.value !== null && !TERMINAL_STATUSES.includes(activeJob.value.status));

  /** Fetches the latest job summaries without changing the current selection. */
  async function loadJobs(): Promise<void> {
    isLoadingJobs.value = true;
    try {
      jobs.value = await getJobs();
    } catch (error) {
      errorMessage.value = toErrorMessage(error);
    } finally {
      isLoadingJobs.value = false;
    }
  }

  /** Selects a job and starts a polling cycle for it if it remains active. */
  async function selectJob(id: string): Promise<void> {
    stopPolling();
    activeJobId.value = id;
    activeJob.value = null;
    await loadDetails(id);
  }

  /** Submits valid textarea content, then makes the created job active. */
  async function submitJob(textareaValue: string): Promise<boolean> {
    const urls = textareaValue.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    if (!urls.length) {
      errorMessage.value = 'Enter at least one URL.';
      return false;
    }
    isSubmitting.value = true;
    errorMessage.value = null;
    try {
      const { jobId } = await createJob(urls);
      await Promise.all([loadJobs(), selectJob(jobId)]);
      return true;
    } catch (error) {
      errorMessage.value = toErrorMessage(error);
      return false;
    } finally {
      isSubmitting.value = false;
    }
  }

  /** Sends cancellation for the active job and refreshes its server state. */
  async function cancelActiveJob(): Promise<void> {
    if (!activeJobId.value) return;
    isCancelling.value = true;
    try {
      await cancelJob(activeJobId.value);
      await Promise.all([loadJobs(), loadDetails(activeJobId.value)]);
    } catch (error) {
      errorMessage.value = toErrorMessage(error);
    } finally {
      isCancelling.value = false;
    }
  }

  /** Clears a scheduled poll; call before any active job transition. */
  function stopPolling(): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function loadDetails(requestedId: string): Promise<void> {
    isLoadingDetails.value = true;
    try {
      const details = await getJob(requestedId);
      if (activeJobId.value !== requestedId) return;
      activeJob.value = details;
      await loadJobs();
      if (!TERMINAL_STATUSES.includes(details.status)) schedulePoll(requestedId);
    } catch (error) {
      if (activeJobId.value === requestedId) errorMessage.value = toErrorMessage(error);
    } finally {
      if (activeJobId.value === requestedId) isLoadingDetails.value = false;
    }
  }

  function schedulePoll(id: string): void {
    stopPolling();
    pollTimer = setTimeout(() => void loadDetails(id), POLL_INTERVAL_MS);
  }

  function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unable to complete the request.';
  }

  return { jobs, activeJobId, activeJob, isLoadingJobs, isLoadingDetails, isSubmitting, isCancelling, errorMessage, completedUrlCount, canCancelActiveJob, loadJobs, selectJob, submitJob, cancelActiveJob, stopPolling };
});
