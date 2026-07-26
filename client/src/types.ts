/** Shared API contract types for the URL checking service. */
export type JobStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
export type UrlCheckStatus = 'pending' | 'in_progress' | 'success' | 'error' | 'cancelled';

export interface JobSummary {
  id: string;
  createdAt: string;
  status: JobStatus;
  totalUrls: number;
  successfulUrls: number;
  errorUrls: number;
}

export interface UrlCheck {
  url: string;
  status: UrlCheckStatus;
  httpStatus?: number;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface JobDetails {
  id: string;
  createdAt: string;
  status: JobStatus;
  urlChecks: UrlCheck[];
}
