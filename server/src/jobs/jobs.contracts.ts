import type { JobStatus, UrlCheckStatus } from './jobs.types';

/** Response returned after a URL-checking job is accepted. */
export interface CreateJobResponse {
  readonly jobId: string;
}

/** Public aggregate representation returned by the job list endpoint. */
export interface JobSummaryResponse {
  readonly id: string;
  readonly createdAt: string;
  readonly status: JobStatus;
  readonly totalUrls: number;
  readonly successfulUrls: number;
  readonly errorUrls: number;
}

/** Public representation of one URL check within a job. */
export interface UrlCheckResponse {
  readonly url: string;
  readonly status: UrlCheckStatus;
  readonly httpStatus?: number;
  readonly errorMessage?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
}

/** Public detail representation returned for one job. */
export interface JobDetailsResponse {
  readonly id: string;
  readonly createdAt: string;
  readonly status: JobStatus;
  readonly urlChecks: readonly UrlCheckResponse[];
}
