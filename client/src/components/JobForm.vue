<script setup lang="ts">
import { ref } from 'vue';
import type { JobFormEmits, JobFormProps } from './JobForm.types';

const props = defineProps<JobFormProps>();
const emit = defineEmits<JobFormEmits>();
const urlsText = ref('https://example.com\nhttps://httpbin.org/status/404');

/** Sends the raw textarea content unless another submission is in progress. */
function submit(): void {
  if (props.isSubmitting) return;
  emit('submit', urlsText.value);
}
</script>

<template>
  <form class="panel form" :aria-busy="isSubmitting" @submit.prevent="submit">
    <div class="section-heading">
      <h2>New check</h2>
      <span id="urls-hint">One URL per line</span>
    </div>
    <label class="field-label" for="urls-input">URLs to check</label>
    <textarea
      id="urls-input"
      v-model="urlsText"
      :aria-describedby="errorMessage ? 'urls-hint submission-error' : 'urls-hint'"
      :disabled="isSubmitting"
      placeholder="https://example.com"
      rows="7"
    />
    <p v-if="errorMessage" id="submission-error" class="alert" role="alert">
      {{ errorMessage }}
    </p>
    <button class="primary" type="submit" :disabled="isSubmitting">
      {{ isSubmitting ? 'Starting checks…' : 'Run checks' }}
    </button>
  </form>
</template>