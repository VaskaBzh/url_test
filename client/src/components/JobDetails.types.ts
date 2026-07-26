import type { JobDetails } from '../types';

/** Props and events for the active job detail panel. */
export interface JobDetailsProps { job: JobDetails | null; completedUrlCount: number; isLoading: boolean; isCancelling: boolean; canCancel: boolean; }
export interface JobDetailsEmits { cancel: []; }
