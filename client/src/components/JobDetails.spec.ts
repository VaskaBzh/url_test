import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { JobDetails } from '../types';
import JobDetailsPanel from './JobDetails.vue';

const JOB_DETAILS: JobDetails = {
  id: 'job-a',
  createdAt: '2026-07-26T10:00:00.000Z',
  status: 'in_progress',
  urlChecks: [
    {
      url: 'https://example.com',
      status: 'success',
      httpStatus: 200,
      durationMs: 120,
    },
    {
      url: 'https://example.com',
      status: 'pending',
    },
  ],
};

function createBaseProps() {
  return {
    job: null,
    completedUrlCount: 0,
    isLoading: false,
    isCancelling: false,
    canCancel: false,
    errorMessage: null,
  };
}

describe('JobDetails', () => {
  it('announces loading without showing the unselected state', () => {
    const wrapper = mount(JobDetailsPanel, {
      props: {
        ...createBaseProps(),
        isLoading: true,
      },
    });

    expect(wrapper.get('[role="status"]').text()).toBe('Loading job…');
    expect(wrapper.text()).not.toContain('Choose a job');
  });

  it('prioritizes an accessible error over the unselected state', () => {
    const wrapper = mount(JobDetailsPanel, {
      props: {
        ...createBaseProps(),
        errorMessage: 'Unable to load this job.',
      },
    });

    expect(wrapper.get('[role="alert"]').text()).toBe('Unable to load this job.');
    expect(wrapper.text()).not.toContain('Choose a job');
  });

  it('renders named table columns and measurable progress', () => {
    const wrapper = mount(JobDetailsPanel, {
      props: {
        ...createBaseProps(),
        job: JOB_DETAILS,
        completedUrlCount: 1,
        canCancel: true,
      },
    });

    expect(wrapper.get('caption').text()).toContain('URL check results');
    expect(wrapper.findAll('th').map((header) => header.text())).toEqual(['URL', 'Status', 'HTTP', 'Duration']);
    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({
      'aria-valuemin': '0',
      'aria-valuemax': '2',
      'aria-valuenow': '1',
    });
  });
});