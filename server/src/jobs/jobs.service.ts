import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
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
import type { Job, JobStatus, UrlCheck, UrlCheckStatus } from './jobs.types';

const MAXIMUM_CONCURRENT_CHECKS = 5;
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const MAXIMUM_RESULT_DELAY_MILLISECONDS = 10_000;

/**
 * Stores jobs in memory and executes URL checks in independent, bounded queues.
 * Jobs are intentionally process-local: restarting the server clears their history.
 */
@Injectable()
export class JobsService {
  private readonly jobs = new Map<string, Job>();
  private readonly logger = new Logger(JobsService.name);

  /** Stores validated URLs and schedules their non-blocking processor. */
  create(urls: readonly string[]): CreateJobResponse {
    const job: Job = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      urlChecks: urls.map((url) => ({ url, status: 'pending' })),
    };

    this.jobs.set(job.id, job);
    this.logger.log(
      `[JobsService.create] job created ${JSON.stringify({
        jobId: job.id,
        urlCount: job.urlChecks.length,
      })}`,
    );
    void this.processJob(job).catch((error: unknown) => {
      this.handleProcessorFailure(job, error);
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
    this.logger.debug(
      `[JobsService.findAll] jobs listed ${JSON.stringify({
        jobCount: jobSummaries.length,
      })}`,
    );

    return jobSummaries;
  }

  /** Returns a public response that cannot mutate in-memory job state. */
  findOne(id: string): JobDetailsResponse {
    const job = this.getJobOrThrow(id);
    this.logger.debug(
      `[JobsService.findOne] job retrieved ${JSON.stringify({
        jobId: job.id,
        status: job.status,
      })}`,
    );
    return this.toJobDetailsResponse(job);
  }

  /** Cancels a job without changing already-terminal URL checks. */
  cancel(id: string): void {
    const job = this.getJobOrThrow(id);
    const previousJobStatus = job.status;
    const previousUrlStatuses = job.urlChecks.map(({ status }) => status);
    const cancelledUrlCount = cancelJob(job);

    if (job.status === previousJobStatus) {
      this.logger.debug(
        `[JobsService.cancel] terminal job cancellation ignored ${JSON.stringify(
          {
            jobId: job.id,
            status: job.status,
          },
        )}`,
      );
      return;
    }

    this.logChangedUrlStatuses(job, previousUrlStatuses);
    this.logger.log(
      `[JobsService.cancel] job transition ${JSON.stringify({
        jobId: job.id,
        previousStatus: previousJobStatus,
        requestedStatus: job.status,
        cancelledUrlCount,
      })}`,
    );
  }

  private async processJob(job: Job): Promise<void> {
    if (job.status === 'cancelled') return;
    this.applyJobStatus(job, 'in_progress');
    let nextUrlIndex = 0;

    const worker = async (workerIndex: number): Promise<void> => {
      this.logger.debug(
        `[JobsService.processJob] worker started ${JSON.stringify({
          jobId: job.id,
          workerIndex,
        })}`,
      );
      while (job.status === 'in_progress') {
        const urlIndex = nextUrlIndex;
        nextUrlIndex += 1;
        const urlCheck = job.urlChecks[urlIndex];
        if (!urlCheck) break;
        await this.processUrlCheck(job, urlCheck, urlIndex);
      }
      this.logger.debug(
        `[JobsService.processJob] worker finished ${JSON.stringify({
          jobId: job.id,
          workerIndex,
          jobStatus: job.status,
        })}`,
      );
    };

    const workerCount = Math.min(
      MAXIMUM_CONCURRENT_CHECKS,
      job.urlChecks.length,
    );
    const workerResults = await Promise.allSettled(
      Array.from({ length: workerCount }, (_, workerIndex) =>
        worker(workerIndex),
      ),
    );
    const rejectedWorker = workerResults.find(
      (workerResult): workerResult is PromiseRejectedResult =>
        workerResult.status === 'rejected',
    );

    if (this.hasJobStatus(job, 'cancelled')) {
      if (rejectedWorker) {
        this.logger.warn(
          `[JobsService.processJob] worker failure ignored after cancellation ${JSON.stringify(
            {
              jobId: job.id,
              errorName: this.toErrorName(rejectedWorker.reason),
            },
          )}`,
        );
      }
      return;
    }
    if (rejectedWorker) throw rejectedWorker.reason;

    this.applyJobStatus(job, 'completed');
  }

  private async processUrlCheck(
    job: Job,
    urlCheck: UrlCheck,
    urlIndex: number,
  ): Promise<void> {
    if (job.status !== 'in_progress' || urlCheck.status !== 'pending') {
      this.logger.debug(
        `[JobsService.processUrlCheck] pending check skipped ${JSON.stringify({
          jobId: job.id,
          urlIndex,
          jobStatus: job.status,
          urlStatus: urlCheck.status,
        })}`,
      );
      return;
    }

    this.applyUrlCheckStatus(job, urlCheck, urlIndex, 'in_progress');
    urlCheck.startedAt = new Date().toISOString();
    const startedAtMilliseconds = Date.now();

    try {
      this.logger.debug(
        `[JobsService.processUrlCheck] HEAD request started ${JSON.stringify({
          jobId: job.id,
          urlIndex,
        })}`,
      );
      const requestOutcome = await this.performHeadRequest(urlCheck.url).then(
        (httpStatus) => ({ httpStatus, isSuccessful: true as const }),
        (error: unknown) => ({ error, isSuccessful: false as const }),
      );
      await this.delayResult();

      if (requestOutcome.isSuccessful) {
        urlCheck.httpStatus = requestOutcome.httpStatus;
        this.applyUrlCheckStatus(job, urlCheck, urlIndex, 'success');
      } else {
        urlCheck.errorMessage = this.toRequestErrorMessage(
          requestOutcome.error,
        );
        this.applyUrlCheckStatus(job, urlCheck, urlIndex, 'error');
        this.logger.warn(
          `[JobsService.processUrlCheck] HEAD request failed ${JSON.stringify({
            jobId: job.id,
            urlIndex,
            errorName: this.toErrorName(requestOutcome.error),
          })}`,
        );
      }
    } finally {
      urlCheck.completedAt = new Date().toISOString();
      urlCheck.durationMs = Date.now() - startedAtMilliseconds;
    }
  }

  private performHeadRequest(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const requestFactory =
        parsedUrl.protocol === 'https:' ? secureRequest : request;
      const clientRequest = requestFactory(
        parsedUrl,
        { method: 'HEAD', timeout: REQUEST_TIMEOUT_MILLISECONDS },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      clientRequest.once('timeout', () =>
        clientRequest.destroy(new Error('Request timed out')),
      );
      clientRequest.once('error', reject);
      clientRequest.end();
    });
  }

  private async delayResult(): Promise<void> {
    const delayMilliseconds = Math.floor(
      Math.random() * (MAXIMUM_RESULT_DELAY_MILLISECONDS + 1),
    );
    await new Promise<void>((resolve) =>
      setTimeout(resolve, delayMilliseconds),
    );
  }

  private handleProcessorFailure(job: Job, error: unknown): void {
    const previousJobStatus = job.status;
    const previousUrlStatuses = job.urlChecks.map(({ status }) => status);
    const didFailJob = failJob(job, new Date().toISOString());

    if (!didFailJob) {
      this.logger.warn(
        `[JobsService.handleProcessorFailure] failure ignored for terminal job ${JSON.stringify(
          {
            jobId: job.id,
            jobStatus: job.status,
            errorName: this.toErrorName(error),
          },
        )}`,
      );
      return;
    }

    this.logChangedUrlStatuses(job, previousUrlStatuses);
    const errorContext = JSON.stringify({
      jobId: job.id,
      previousStatus: previousJobStatus,
      requestedStatus: job.status,
      errorName: this.toErrorName(error),
    });
    this.logger.error(
      `[JobsService.handleProcessorFailure] job transition ${errorContext}`,
      this.toSafeStack(error),
    );
  }

  private applyJobStatus(job: Job, requestedStatus: JobStatus): void {
    const previousStatus = job.status;
    if (!transitionJobStatus(job, requestedStatus)) return;

    this.logger.log(
      `[JobsService.applyJobStatus] job transition ${JSON.stringify({
        jobId: job.id,
        previousStatus,
        requestedStatus,
      })}`,
    );
  }

  private applyUrlCheckStatus(
    job: Job,
    urlCheck: UrlCheck,
    urlIndex: number,
    requestedStatus: UrlCheckStatus,
  ): void {
    const previousStatus = urlCheck.status;
    if (!transitionUrlCheckStatus(urlCheck, requestedStatus)) return;

    this.logger.debug(
      `[JobsService.applyUrlCheckStatus] URL transition ${JSON.stringify({
        jobId: job.id,
        urlIndex,
        previousStatus,
        requestedStatus,
      })}`,
    );
  }

  private logChangedUrlStatuses(
    job: Job,
    previousUrlStatuses: readonly UrlCheckStatus[],
  ): void {
    job.urlChecks.forEach((urlCheck, urlIndex) => {
      const previousStatus = previousUrlStatuses[urlIndex];
      if (!previousStatus || previousStatus === urlCheck.status) return;
      this.logger.debug(
        `[JobsService.logChangedUrlStatuses] URL transition ${JSON.stringify({
          jobId: job.id,
          urlIndex,
          previousStatus,
          requestedStatus: urlCheck.status,
        })}`,
      );
    });
  }

  private hasJobStatus(job: Job, expectedStatus: JobStatus): boolean {
    return job.status === expectedStatus;
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

  private toRequestErrorMessage(error: unknown): string {
    return error instanceof Error && error.message === 'Request timed out'
      ? 'Request timed out'
      : 'URL request failed';
  }

  private toErrorName(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
  }

  private toSafeStack(error: unknown): string | undefined {
    if (!(error instanceof Error) || !error.stack) return undefined;
    return error.stack.replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]');
  }
}
