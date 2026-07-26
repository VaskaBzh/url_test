import type { JobDetails } from '../types';

/** Props controlling the active job detail panel. */
export interface JobDetailsProps {
  job: JobDetails | null;
  completedUrlCount: number;
  isLoading: boolean;
  isCancelling: boolean;
  canCancel: boolean;
  errorMessage: string | null;
}

/** Events emitted from active job controls. */
export interface JobDetailsEmits {
  cancel: [];
}