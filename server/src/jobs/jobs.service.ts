import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HeadRequestService } from './head-request.service';
import type {
  CreateJobResponse,
  JobDetailsResponse,
  JobSummaryResponse,
  UrlCheckResponse,
} from './jobs.contracts';
import {
  cancelJob,
  failJob,
  transitionJobStatus,
  transitionUrlCheckStatus,
} from './jobs.lifecycle';
import { ResultDelayService } from './result-delay.service';
import type {
  Job,
  JobProcessingFailureStage,
  JobStatus,
  UrlCheck,
  UrlCheckStatus,
} from './jobs.types';

const MAXIMUM_CONCURRENT_CHECKS = 5;

/**
 * Stores jobs in memory and executes URL checks in independent, bounded queues.
 * Jobs are intentionally process-local: restarting the server clears their history.
 */
@Injectable()
export class JobsService {
  private readonly jobs = new Map<string, Job>();
  private readonly jobsWithProcessingFailure = new Set<string>();
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly headRequestService: HeadRequestService,
    private readonly resultDelayService: ResultDelayService,
  ) {}

  /** Stores validated URLs and schedules their non-blocking processor. */
  create(urls: readonly string[]): CreateJobResponse {
    const job: Job = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      urlChecks: urls.map((url) => ({ url, status: 'pending' })),
    };

    this.jobs.set(job.id, job);
    this.logger.log({
      event: 'job_created',
      jobId: job.id,
      urlCount: job.urlChecks.length,
    });
    void this.processJob(job).catch((error: unknown) => {
      this.handleProcessorFailure(job, error, 'detached_boundary');
    });

    return { jobId: job.id };
  }

  /** Returns job summaries ordered from newest to oldest. */
  findAll(): readonly JobSummaryResponse[] {
    const jobSummaries = [...this.jobs.values()]
      .sort((firstJob, secondJob) =>
        secondJob.createdAt.localeCompare(firstJob.createdAt),
      )
      .map((job) => this.toJobSummaryResponse(job));

    this.logger.debug({
      event: 'jobs_listed',
      jobCount: jobSummaries.length,
    });

    return jobSummaries;
  }

  /** Returns a public response that cannot mutate in-memory job state. */
  findOne(id: string): JobDetailsResponse {
    const job = this.getJobOrThrow(id);

    this.logger.debug({
      event: 'job_retrieved',
      jobId: job.id,
      status: job.status,
    });

    return this.toJobDetailsResponse(job);
  }

  /** Cancels a job without changing already-terminal URL checks. */
  cancel(id: string): void {
    const job = this.getJobOrThrow(id);
    const previousJobStatus = job.status;
    const previousUrlStatuses = job.urlChecks.map(({ status }) => status);
    const cancelledUrlCount = cancelJob(job);

    if (job.status === previousJobStatus) {
      this.logger.debug({
        event: 'job_cancellation_skipped',
        jobId: job.id,
        state: job.status,
      });
      return;
    }

    this.logChangedUrlStatuses(job, previousUrlStatuses);
    this.logger.log({
      event: 'job_cancelled',
      jobId: job.id,
      cancelledUrlCount,
    });
  }

  private async processJob(job: Job): Promise<void> {
    if (job.status === 'cancelled') return;

    this.applyJobStatus(job, 'in_progress');
    let nextUrlIndex = 0;
    const workerCount = Math.min(
      MAXIMUM_CONCURRENT_CHECKS,
      job.urlChecks.length,
    );

    this.logger.debug({
      event: 'job_processing_started',
      jobId: job.id,
      state: job.status,
      urlCount: job.urlChecks.length,
      workerCount,
    });

    const worker = async (workerIndex: number): Promise<void> => {
      while (true) {
        const stopReason = this.getProcessingStopReason(job);
        if (stopReason) {
          this.logger.debug({
            event: 'job_worker_stopped',
            jobId: job.id,
            workerIndex,
            reason: stopReason,
          });
          return;
        }

        const urlIndex = nextUrlIndex;
        nextUrlIndex += 1;
        const urlCheck = job.urlChecks[urlIndex];
        if (!urlCheck) return;

        this.logger.debug({
          event: 'job_worker_check_started',
          jobId: job.id,
          urlIndex,
          workerIndex,
        });
        await this.processUrlCheck(job, urlCheck, urlIndex);
      }
    };

    try {
      await Promise.all(
        Array.from({ length: workerCount }, (_, workerIndex) =>
          worker(workerIndex),
        ),
      );
    } catch (error: unknown) {
      this.handleProcessorFailure(job, error, 'worker');
      return;
    }

    if (this.getProcessingStopReason(job)) return;

    this.applyJobStatus(job, 'completed');
    this.logger.debug({
      event: 'job_processing_completed',
      jobId: job.id,
      state: job.status,
      successfulUrlCount: job.urlChecks.filter(
        ({ status }) => status === 'success',
      ).length,
      errorUrlCount: job.urlChecks.filter(({ status }) => status === 'error')
        .length,
    });
  }

  private async processUrlCheck(
    job: Job,
    urlCheck: UrlCheck,
    urlIndex: number,
  ): Promise<void> {
    if (job.status !== 'in_progress' || urlCheck.status !== 'pending') {
      this.logger.debug({
        event: 'url_check_skipped',
        jobId: job.id,
        urlIndex,
        jobStatus: job.status,
        urlStatus: urlCheck.status,
      });
      return;
    }

    this.applyUrlCheckStatus(job, urlCheck, urlIndex, 'in_progress');
    urlCheck.startedAt = new Date().toISOString();
    const startedAtMilliseconds = Date.now();

    try {
      const requestOutcome = await this.headRequestService.check(urlCheck.url);
      if (this.hasProcessingFailure(job)) {
        this.logger.debug({
          event: 'url_check_result_discarded',
          jobId: job.id,
          urlIndex,
          stage: 'after_request',
        });
        return;
      }

      await this.resultDelayService.wait();
      if (this.hasProcessingFailure(job)) {
        this.logger.debug({
          event: 'url_check_result_discarded',
          jobId: job.id,
          urlIndex,
          stage: 'after_delay',
        });
        return;
      }

      if (requestOutcome.kind === 'success') {
        urlCheck.httpStatus = requestOutcome.httpStatus;
        this.applyUrlCheckStatus(job, urlCheck, urlIndex, 'success');
      } else {
        urlCheck.errorMessage = requestOutcome.errorMessage;
        this.applyUrlCheckStatus(job, urlCheck, urlIndex, 'error');
        this.logger.warn(
          JSON.stringify({
            event: 'url_check_transport_failed',
            jobId: job.id,
            urlIndex,
            errorType:
              requestOutcome.errorMessage === 'Request timed out'
                ? 'timeout'
                : 'transport',
          }),
        );
      }

      this.logger.debug({
        event: 'url_check_result_published',
        jobId: job.id,
        urlIndex,
        state: urlCheck.status,
      });
    } finally {
      urlCheck.completedAt ??= new Date().toISOString();
      urlCheck.durationMs ??= Date.now() - startedAtMilliseconds;
    }
  }

  private handleProcessorFailure(
    job: Job,
    error: unknown,
    failureStage: JobProcessingFailureStage,
  ): void {
    if (this.jobsWithProcessingFailure.has(job.id)) {
      this.logger.debug({
        event: 'job_processing_failure_already_handled',
        jobId: job.id,
        failureStage,
      });
      return;
    }

    this.jobsWithProcessingFailure.add(job.id);
    const previousJobStatus = job.status;
    const previousUrlStatuses = job.urlChecks.map(({ status }) => status);
    const didChangeState = failJob(job, new Date().toISOString());
    const errorName = this.toErrorName(error);

    if (!didChangeState) {
      this.logger.debug({
        event: 'job_processing_failure_ignored',
        jobId: job.id,
        failureStage,
        jobStatus: job.status,
        errorName,
      });
      return;
    }

    this.logChangedUrlStatuses(job, previousUrlStatuses);

    if (job.status === 'cancelled') {
      this.logger.warn(
        JSON.stringify({
          event: 'job_processing_failure_after_cancellation',
          jobId: job.id,
          failureStage,
          errorName,
        }),
      );
      return;
    }

    this.logger.error(
      {
        event: 'job_processing_failed',
        jobId: job.id,
        previousStatus: previousJobStatus,
        requestedStatus: job.status,
        failureStage,
        errorName,
      },
      this.toSafeStack(error),
    );
  }

  private applyJobStatus(job: Job, requestedStatus: JobStatus): void {
    const previousStatus = job.status;
    if (!transitionJobStatus(job, requestedStatus)) return;

    this.logger.log({
      event: 'job_transition',
      jobId: job.id,
      previousStatus,
      requestedStatus,
    });
  }

  private applyUrlCheckStatus(
    job: Job,
    urlCheck: UrlCheck,
    urlIndex: number,
    requestedStatus: UrlCheckStatus,
  ): void {
    const previousStatus = urlCheck.status;
    if (!transitionUrlCheckStatus(urlCheck, requestedStatus)) return;

    this.logger.debug({
      event: 'url_check_state_changed',
      jobId: job.id,
      urlIndex,
      previousState: previousStatus,
      nextState: requestedStatus,
    });
  }

  private logChangedUrlStatuses(
    job: Job,
    previousUrlStatuses: readonly UrlCheckStatus[],
  ): void {
    job.urlChecks.forEach((urlCheck, urlIndex) => {
      const previousStatus = previousUrlStatuses[urlIndex];
      if (!previousStatus || previousStatus === urlCheck.status) return;

      this.logger.debug({
        event: 'url_check_state_changed',
        jobId: job.id,
        urlIndex,
        previousState: previousStatus,
        nextState: urlCheck.status,
      });
    });
  }

  private getProcessingStopReason(
    job: Job,
  ): 'job_cancelled' | 'job_failed' | null {
    if (job.status === 'cancelled') return 'job_cancelled';
    if (this.hasProcessingFailure(job)) return 'job_failed';
    return null;
  }

  private hasProcessingFailure(job: Job): boolean {
    return this.jobsWithProcessingFailure.has(job.id);
  }

  private getJobOrThrow(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException('Job was not found');
    return job;
  }

  private toJobSummaryResponse(job: Job): JobSummaryResponse {
    return {
      id: job.id,
      createdAt: job.createdAt,
      status: job.status,
      totalUrls: job.urlChecks.length,
      successfulUrls: job.urlChecks.filter(({ status }) => status === 'success')
        .length,
      errorUrls: job.urlChecks.filter(({ status }) => status === 'error')
        .length,
    };
  }

  private toJobDetailsResponse(job: Job): JobDetailsResponse {
    return {
      id: job.id,
      createdAt: job.createdAt,
      status: job.status,
      urlChecks: job.urlChecks.map((urlCheck) =>
        this.toUrlCheckResponse(urlCheck),
      ),
    };
  }

  private toUrlCheckResponse(urlCheck: UrlCheck): UrlCheckResponse {
    return {
      url: urlCheck.url,
      status: urlCheck.status,
      ...(urlCheck.httpStatus === undefined
        ? {}
        : { httpStatus: urlCheck.httpStatus }),
      ...(urlCheck.errorMessage === undefined
        ? {}
        : { errorMessage: urlCheck.errorMessage }),
      ...(urlCheck.startedAt === undefined
        ? {}
        : { startedAt: urlCheck.startedAt }),
      ...(urlCheck.completedAt === undefined
        ? {}
        : { completedAt: urlCheck.completedAt }),
      ...(urlCheck.durationMs === undefined
        ? {}
        : { durationMs: urlCheck.durationMs }),
    };
  }

  private toErrorName(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
  }

  private toSafeStack(error: unknown): string | undefined {
    if (!(error instanceof Error) || !error.stack) return undefined;
    return error.stack.replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]');
  }
}
