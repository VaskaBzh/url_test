/** A lifecycle state for an asynchronous URL-checking job. */
export type JobStatus =
  'pending' | 'in_progress' | 'completed' | 'cancelled' | 'failed';

/** A lifecycle state for one URL within a job. */
export type UrlCheckStatus =
  'pending' | 'in_progress' | 'success' | 'error' | 'cancelled';

/** Mutable in-memory representation of an individual URL check. */
export interface UrlCheck {
  url: string;
  status: UrlCheckStatus;
  httpStatus?: number;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

/** Mutable in-memory representation of a submitted job. */
export interface Job {
  id: string;
  createdAt: string;
  status: JobStatus;
  urlChecks: UrlCheck[];
}

/** Compact job shape returned by the job list endpoint. */
export interface JobSummary {
  id: string;
  createdAt: string;
  status: JobStatus;
  totalUrls: number;
  successfulUrls: number;
  errorUrls: number;
}
