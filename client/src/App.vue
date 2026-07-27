<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import JobDetails from './components/JobDetails.vue';
import JobForm from './components/JobForm.vue';
import JobList from './components/JobList.vue';
import { useJobsStore } from './store/jobs.store';

const jobsStore = useJobsStore();
onMounted(() => void jobsStore.loadJobs());
onUnmounted(() => jobsStore.stopPolling());
</script>

<template>
  <main class="app-shell">
    <header>
      <p class="eyebrow">ASYNC URL INSPECTOR</p>
      <h1>Know what your links return.</h1>
      <p>Submit a list, then follow every HEAD request as it completes.</p>
    </header>
    <div class="workspace">
      <aside>
        <JobForm
          :is-submitting="jobsStore.isSubmitting"
          :error-message="jobsStore.submissionErrorMessage"
          @submit="jobsStore.submitJob"
        />
        <JobList
          :jobs="jobsStore.jobs"
          :active-job-id="jobsStore.activeJobId"
          :is-loading="jobsStore.isLoadingJobs"
          :error-message="jobsStore.listErrorMessage"
          @select="jobsStore.selectJob"
        />
      </aside>
      <JobDetails
        :job="jobsStore.activeJob"
        :completed-url-count="jobsStore.completedUrlCount"
        :is-loading="jobsStore.isLoadingDetails"
        :is-cancelling="jobsStore.isCancelling"
        :can-cancel="jobsStore.canCancelActiveJob"
        :error-message="jobsStore.detailsErrorMessage ?? jobsStore.cancellationErrorMessage"
        @cancel="jobsStore.cancelActiveJob"
      />
    </div>
  </main>
</template>