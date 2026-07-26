import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import JobForm from './JobForm.vue';

describe('JobForm submission contract', () => {
  it('renders an accessible textarea inside a submit form', () => {
    const wrapper = mount(JobForm);

    expect(wrapper.get('form').element.tagName).toBe('FORM');
    expect(wrapper.get('textarea').attributes('aria-label')).toBe('URLs to check');
    expect(wrapper.get('button[type="submit"]').text()).toBe('Run checks');
  });

  it('emits the current multiline value exactly once through form submission', async () => {
    const wrapper = mount(JobForm);
    const rawUrlsText = ' https://one.example \n\nhttps://two.example/path ';

    await wrapper.get('textarea').setValue(rawUrlsText);
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('submit')).toEqual([[rawUrlsText]]);
  });

  it('passes whitespace-only text to the store layer without component validation', async () => {
    const wrapper = mount(JobForm);
    const whitespaceOnlyText = '  \n\t ';

    await wrapper.get('textarea').setValue(whitespaceOnlyText);
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('submit')).toEqual([[whitespaceOnlyText]]);
  });
});
