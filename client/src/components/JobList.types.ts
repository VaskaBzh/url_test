import type { JobSummary } from '../types';

/** Props and events for the selectable job summary list. */
export interface JobListProps { jobs: JobSummary[]; activeJobId: string | null; isLoading: boolean; }
export interface JobListEmits { select: [id: string]; }
