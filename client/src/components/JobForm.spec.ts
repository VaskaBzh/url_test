import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import JobForm from './JobForm.vue';

describe('JobForm', () => {
  it('disables submission controls and suppresses repeated submit events', async () => {
    const wrapper = mount(JobForm, {
      props: {
        isSubmitting: true,
        errorMessage: null,
      },
    });

    expect(wrapper.get('form').attributes('aria-busy')).toBe('true');
    expect(wrapper.get('textarea').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('button').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('button').text()).toBe('Starting checks…');

    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });
});