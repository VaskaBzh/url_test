<script setup lang="ts">
import type { JobDetailsEmits, JobDetailsProps } from './JobDetails.types';
defineProps<JobDetailsProps>();
const emit = defineEmits<JobDetailsEmits>();

/** Formats a measured URL-check duration. */
function formatDuration(milliseconds?: number): string { return milliseconds === undefined ? '—' : `${(milliseconds / 1000).toFixed(1)} s`; }
</script>

<template>
  <section class="panel details-panel">
    <p v-if="isLoading && !job" class="muted">Loading job…</p>
    <p v-else-if="!job" class="muted">Choose a job to view its results.</p>
    <template v-else>
      <div class="details-header"><div><h2>Job {{ job.id.slice(0, 8) }}</h2><p><span class="status" :data-status="job.status">{{ job.status.replace('_', ' ') }}</span> {{ completedUrlCount }} of {{ job.urlChecks.length }} processed</p></div><button v-if="canCancel" class="danger" :disabled="isCancelling" @click="emit('cancel')">{{ isCancelling ? 'Cancelling…' : 'Cancel job' }}</button></div>
      <div class="progress"><span :style="{ width: `${job.urlChecks.length ? (completedUrlCount / job.urlChecks.length) * 100 : 0}%` }" /></div>
      <div class="url-table"><div v-for="urlCheck in job.urlChecks" :key="urlCheck.url" class="url-row"><div><a :href="urlCheck.url" target="_blank" rel="noreferrer">{{ urlCheck.url }}</a><small v-if="urlCheck.errorMessage" class="error">{{ urlCheck.errorMessage }}</small></div><span class="status" :data-status="urlCheck.status">{{ urlCheck.status.replace('_', ' ') }}</span><span>{{ urlCheck.httpStatus ?? '—' }}</span><span>{{ formatDuration(urlCheck.durationMs) }}</span></div></div>
    </template>
  </section>
</template>
