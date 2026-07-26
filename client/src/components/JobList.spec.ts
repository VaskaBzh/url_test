import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { JobSummary } from '../types';
import JobList from './JobList.vue';

const JOB_SUMMARY: JobSummary = {
  id: 'job-a',
  createdAt: '2026-07-26T10:00:00.000Z',
  status: 'completed',
  totalUrls: 1,
  successfulUrls: 1,
  errorUrls: 0,
};

describe('JobList', () => {
  it('shows loading instead of an empty-state message during the initial request', () => {
    const wrapper = mount(JobList, {
      props: {
        jobs: [],
        activeJobId: null,
        isLoading: true,
        errorMessage: null,
      },
    });

    expect(wrapper.get('[role="status"]').text()).toBe('Loading jobs…');
    expect(wrapper.text()).not.toContain('No jobs have been created yet.');
  });

  it('exposes the active job selection programmatically', () => {
    const wrapper = mount(JobList, {
      props: {
        jobs: [JOB_SUMMARY],
        activeJobId: JOB_SUMMARY.id,
        isLoading: false,
        errorMessage: null,
      },
    });

    expect(wrapper.get('button').attributes('aria-current')).toBe('true');
  });
});