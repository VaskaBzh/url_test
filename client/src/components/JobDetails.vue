<script setup lang="ts">
import type { JobDetailsEmits, JobDetailsProps } from './JobDetails.types';

defineProps<JobDetailsProps>();
const emit = defineEmits<JobDetailsEmits>();

/** Formats a measured URL-check duration. */
function formatDuration(milliseconds?: number): string {
  return milliseconds === undefined ? '—' : `${(milliseconds / 1000).toFixed(1)} s`;
}
</script>

<template>
  <section class="panel details-panel" :aria-busy="isLoading">
    <p v-if="isLoading && !job" class="muted" role="status" aria-live="polite">Loading job…</p>
    <p v-else-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>
    <p v-else-if="!job" class="muted">Choose a job to view its results.</p>
    <template v-else>
      <div class="details-header">
        <div>
          <h2>Job {{ job.id.slice(0, 8) }}</h2>
          <p class="progress-summary" role="status" aria-live="polite" aria-atomic="true">
            <span class="status" :data-status="job.status">{{ job.status.replace('_', ' ') }}</span>
            {{ completedUrlCount }} of {{ job.urlChecks.length }} processed
          </p>
        </div>
        <button
          v-if="canCancel || isCancelling"
          class="danger"
          type="button"
          :disabled="isCancelling"
          @click="emit('cancel')"
        >
          {{ isCancelling ? 'Cancelling…' : 'Cancel job' }}
        </button>
      </div>
      <p v-if="isLoading" class="muted" role="status" aria-live="polite">Updating results…</p>
      <div
        class="progress"
        role="progressbar"
        aria-label="Job progress"
        aria-valuemin="0"
        :aria-valuemax="job.urlChecks.length"
        :aria-valuenow="completedUrlCount"
      >
        <span
          aria-hidden="true"
          :style="{ width: `${job.urlChecks.length ? (completedUrlCount / job.urlChecks.length) * 100 : 0}%` }"
        />
      </div>
      <div class="table-scroll">
        <table class="url-table">
          <caption class="visually-hidden">URL check results for job {{ job.id.slice(0, 8) }}</caption>
          <thead>
            <tr>
              <th scope="col">URL</th>
              <th scope="col">Status</th>
              <th scope="col">HTTP</th>
              <th scope="col">Duration</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(urlCheck, urlCheckIndex) in job.urlChecks"
              :key="`${urlCheck.url}-${urlCheckIndex}`"
            >
              <td>
                <a :href="urlCheck.url" target="_blank" rel="noreferrer">{{ urlCheck.url }}</a>
                <small v-if="urlCheck.errorMessage" class="error">{{ urlCheck.errorMessage }}</small>
              </td>
              <td><span class="status" :data-status="urlCheck.status">{{ urlCheck.status.replace('_', ' ') }}</span></td>
              <td>{{ urlCheck.httpStatus ?? '—' }}</td>
              <td>{{ formatDuration(urlCheck.durationMs) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>