<script setup lang="ts">
import { ref } from 'vue';
import type { JobFormEmits } from './JobForm.types';

const emit = defineEmits<JobFormEmits>();
const urlsText = ref('https://example.com\nhttps://httpbin.org/status/404');

/** Sends the raw textarea content to the global job store. */
function submit(): void {
  emit('submit', urlsText.value);
}
</script>

<template>
  <form class="panel form" @submit.prevent="submit">
    <div class="section-heading"><h2>New check</h2><span>One URL per line</span></div>
    <textarea v-model="urlsText" aria-label="URLs to check" placeholder="https://example.com" rows="7" />
    <button class="primary" type="submit">Run checks</button>
  </form>
</template>
