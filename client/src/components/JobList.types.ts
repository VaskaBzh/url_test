import type { JobSummary } from '../types';

/** Props controlling the selectable job summary list. */
export interface JobListProps {
  jobs: JobSummary[];
  activeJobId: string | null;
  isLoading: boolean;
  errorMessage: string | null;
}

/** Events emitted when the user selects a job summary. */
export interface JobListEmits {
  select: [id: string];
}