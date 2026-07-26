import type { JobDetails, JobSummary, UrlCheck } from '../types';

const DEFAULT_CREATED_AT = '2026-07-26T10:00:00.000Z';

/** Creates a typed job summary with stable defaults for store assertions. */
export function createJobSummary(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'job-1',
    createdAt: DEFAULT_CREATED_AT,
    status: 'pending',
    totalUrls: 1,
    successfulUrls: 0,
    errorUrls: 0,
    ...overrides,
  } satisfies JobSummary;
}

/** Creates a typed URL check with stable defaults for aggregate-state assertions. */
export function createUrlCheck(overrides: Partial<UrlCheck> = {}): UrlCheck {
  return {
    url: 'https://example.com',
    status: 'pending',
    ...overrides,
  } satisfies UrlCheck;
}

/** Creates typed job details while allowing each test to override only relevant state. */
export function createJobDetails(overrides: Partial<JobDetails> = {}): JobDetails {
  return {
    id: 'job-1',
    createdAt: DEFAULT_CREATED_AT,
    status: 'pending',
    urlChecks: [createUrlCheck()],
    ...overrides,
  } satisfies JobDetails;
}
