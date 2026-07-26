<script setup lang="ts">
import type { JobListEmits, JobListProps } from './JobList.types';
defineProps<JobListProps>();
const emit = defineEmits<JobListEmits>();

/** Formats an ISO date into the viewer's local time. */
function formatDate(value: string): string { return new Date(value).toLocaleString(); }
</script>

<template>
  <section class="panel jobs-panel">
    <div class="section-heading"><h2>Recent jobs</h2><span v-if="isLoading">Updating…</span></div>
    <p v-if="!jobs.length" class="muted">No jobs have been created yet.</p>
    <button v-for="job in jobs" :key="job.id" class="job-item" :class="{ selected: job.id === activeJobId }" @click="emit('select', job.id)">
      <span><strong>{{ job.id.slice(0, 8) }}</strong><small>{{ formatDate(job.createdAt) }}</small></span>
      <span class="status" :data-status="job.status">{{ job.status.replace('_', ' ') }}</span>
      <small>{{ job.successfulUrls }} ok · {{ job.errorUrls }} errors · {{ job.totalUrls }} total</small>
    </button>
  </section>
</template>
