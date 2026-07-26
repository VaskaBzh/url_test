import type { JobDetails, JobSummary } from '../types';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

/** Thin HTTP client for the job REST API with stable, client-safe error messages. */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, options);
  } catch {
    throw new Error('Unable to reach the service. Please try again.');
  }

  if (!response.ok) {
    throw new Error(toClientErrorMessage(response.status));
  }
  if (response.status === 204) return undefined as T;

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('The service returned an invalid response.');
  }
}

function toClientErrorMessage(httpStatus: number): string {
  if (httpStatus === 400) return 'The submitted request is invalid.';
  if (httpStatus === 404) return 'The requested job was not found.';
  if (httpStatus === 429) {
    return 'Too many requests. Please wait and try again.';
  }
  if (httpStatus >= 500) {
    return 'The service is temporarily unavailable. Please try again.';
  }
  return 'Unable to complete the request.';
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
export function getJobs(): Promise<JobSummary[]> {
  return request('/jobs');
}

/** Gets all individual URL checks for a job. */
export function getJob(id: string): Promise<JobDetails> {
  return request(`/jobs/${id}`);
}

/** Cancels a job without aborting already in-flight HTTP checks. */
export function cancelJob(id: string): Promise<void> {
  return request(`/jobs/${id}`, { method: 'DELETE' });
}
