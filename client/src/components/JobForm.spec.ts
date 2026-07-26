import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import JobForm from './JobForm.vue';

function createProps(overrides: Partial<{ errorMessage: string | null; isSubmitting: boolean }> = {}) {
  return {
    errorMessage: null,
    isSubmitting: false,
    ...overrides,
  };
}

describe('JobForm', () => {
  it('renders an accessible textarea inside a submit form', () => {
    const wrapper = mount(JobForm, { props: createProps() });

    expect(wrapper.get('form').element.tagName).toBe('FORM');
    expect(wrapper.get('label[for="urls-input"]').text()).toBe('URLs to check');
    expect(wrapper.get('textarea').attributes('id')).toBe('urls-input');
    expect(wrapper.get('button[type="submit"]').text()).toBe('Run checks');
  });

  it('emits the current multiline value exactly once through form submission', async () => {
    const wrapper = mount(JobForm, { props: createProps() });
    const rawUrlsText = ' https://one.example \n\nhttps://two.example/path ';

    await wrapper.get('textarea').setValue(rawUrlsText);
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('submit')).toEqual([[rawUrlsText]]);
  });

  it('passes whitespace-only text to the store layer without component validation', async () => {
    const wrapper = mount(JobForm, { props: createProps() });
    const whitespaceOnlyText = '  \n\t ';

    await wrapper.get('textarea').setValue(whitespaceOnlyText);
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('submit')).toEqual([[whitespaceOnlyText]]);
  });

  it('disables submission controls and suppresses repeated submit events', async () => {
    const wrapper = mount(JobForm, {
      props: createProps({ isSubmitting: true }),
    });

    expect(wrapper.get('form').attributes('aria-busy')).toBe('true');
    expect(wrapper.get('textarea').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('button').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('button').text()).toBe('Starting checks...');

    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });
});
