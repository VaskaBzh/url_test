import type { JobDetails, JobSummary } from '../types';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

/** Thin HTTP client for the job REST API. */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(Array.isArray(body.message) ? body.message.join(', ') : body.message);
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

/** Identifies request cancellation so obsolete workflows can finish silently. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Creates a new URL checking job. */
export function createJob(urls: string[]): Promise<{ jobId: string }> {
  return request('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
}

/** Gets summaries for every job currently held by the server. */
export function getJobs(signal?: AbortSignal): Promise<JobSummary[]> {
  return request('/jobs', { signal });
}

/** Gets all individual URL checks for a job. */
export function getJob(id: string, signal?: AbortSignal): Promise<JobDetails> {
  return request(`/jobs/${id}`, { signal });
}

/** Cancels a job without aborting already in-flight HTTP checks. */
export function cancelJob(id: string): Promise<void> {
  return request(`/jobs/${id}`, { method: 'DELETE' });
}
