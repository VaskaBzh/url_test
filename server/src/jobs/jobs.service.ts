import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HeadRequestService } from './head-request.service';
import type {
  Job,
  JobProcessingFailureStage,
  JobStatus,
  JobSummary,
  UrlCheck,
} from './jobs.types';
import { ResultDelayService } from './result-delay.service';

const MAX_CONCURRENT_CHECKS_PER_JOB = 5;
const MAX_GLOBAL_CONCURRENT_REQUESTS = 20;
const MAX_PENDING_URL_CHECKS = 1_000;
const MAX_STORED_JOBS = 100;
const MAX_URLS_PER_JOB = 50;
const MAX_URL_LENGTH = 2_048;
const INTERNAL_PROCESSING_ERROR_MESSAGE = 'Internal job processing error';

/**
 * Stores jobs in memory and executes URL checks in independent, bounded queues.
 * Jobs are intentionally process-local: restarting the server clears their history.
 */
@Injectable()
export class JobsService {
  private readonly jobs = new Map<string, Job>();
  private readonly jobsWithProcessingFailure = new Set<string>();
  private readonly logger = new Logger(JobsService.name);
  private activeRequestCount = 0;
  private readonly requestWaiters: Array<() => void> = [];

  constructor(
    private readonly headRequestService: HeadRequestService,
    private readonly resultDelayService: ResultDelayService,
  ) {}

  /** Validates submitted URLs, stores the job, and schedules its non-blocking processor. */
  create(rawUrls: unknown): { jobId: string } {
    const urls = this.validateUrls(rawUrls);
    this.ensureJobCapacity();
    this.ensureUrlCheckCapacity(urls.length);

    const job: Job = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      urlChecks: urls.map((url) => ({ url, status: 'pending' })),
    };

    this.jobs.set(job.id, job);
    this.logger.debug({
      event: 'job_created',
      jobId: job.id,
      state: job.status,
      urlCount: job.urlChecks.length,
    });
    void this.processJob(job).catch((error: unknown) => {
      this.handleJobProcessingFailure(job, error, 'detached_boundary');
    });
    return { jobId: job.id };
  }

  /** Returns job summaries ordered from newest to oldest. */
  findAll(): JobSummary[] {
    return [...this.jobs.values()]
      .sort((firstJob, secondJob) =>
        secondJob.createdAt.localeCompare(firstJob.createdAt),
      )
      .map((job) => this.toSummary(job));
  }

  /** Returns a defensive copy so callers cannot mutate in-memory job state. */
  findOne(id: string): Job {
    const job = this.getJobOrThrow(id);
    return structuredClone(job);
  }

  /** Marks queued checks cancelled while allowing already-started HTTP requests to finish safely. */
  cancel(id: string): void {
    const job = this.getJobOrThrow(id);
    if (this.isTerminal(job.status)) {
      this.logger.debug({
        event: 'job_cancellation_skipped',
        jobId: job.id,
        state: job.status,
      });
      return;
    }

    job.status = 'cancelled';
    let cancelledUrlCount = 0;
    for (const urlCheck of job.urlChecks) {
      if (urlCheck.status === 'pending') {
        urlCheck.status = 'cancelled';
        cancelledUrlCount += 1;
      }
    }
    this.logger.log({
      event: 'job_cancelled',
      jobId: job.id,
      cancelledUrlCount,
    });
  }

  private async processJob(job: Job): Promise<void> {
    if (job.status === 'cancelled') return;
    job.status = 'in_progress';
    let nextIndex = 0;

    this.logger.debug({
      event: 'job_processing_started',
      jobId: job.id,
      state: job.status,
      urlCount: job.urlChecks.length,
      workerCount: Math.min(
        MAX_CONCURRENT_CHECKS_PER_JOB,
        job.urlChecks.length,
      ),
    });

    const worker = async (workerIndex: number): Promise<void> => {
      while (true) {
        if (this.shouldStopProcessing(job)) {
          this.logger.debug({
            event: 'job_worker_stopped',
            jobId: job.id,
            workerIndex,
            reason: job.status === 'cancelled' ? 'job_cancelled' : 'job_failed',
          });
          return;
        }
        const urlIndex = nextIndex++;
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
        Array.from(
          {
            length: Math.min(
              MAX_CONCURRENT_CHECKS_PER_JOB,
              job.urlChecks.length,
            ),
          },
          worker,
        ),
      );
    } catch (error: unknown) {
      this.handleJobProcessingFailure(job, error, 'worker');
      return;
    }

    if (this.shouldStopProcessing(job)) return;
    job.status = 'completed';
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
    if (this.isCancelled(job)) {
      urlCheck.status = 'cancelled';
      return;
    }

    this.logger.debug({
      event: 'url_check_state_changed',
      jobId: job.id,
      urlIndex,
      previousState: urlCheck.status,
      nextState: 'in_progress',
    });
    urlCheck.status = 'in_progress';
    urlCheck.startedAt = new Date().toISOString();
    const startedAtMilliseconds = Date.now();
    const releaseRequestPermit = await this.acquireRequestPermit();

    try {
      if (this.isCancelled(job)) {
        urlCheck.status = 'cancelled';
        return;
      }

      const requestOutcome = await this.headRequestService.check(urlCheck.url);
      if (this.jobsWithProcessingFailure.has(job.id)) {
        this.logger.debug({
          event: 'url_check_result_discarded',
          jobId: job.id,
          urlIndex,
          stage: 'after_request',
        });
        return;
      }

      await this.resultDelayService.wait();
      if (this.jobsWithProcessingFailure.has(job.id)) {
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
        urlCheck.status = 'success';
      } else {
        urlCheck.errorMessage = requestOutcome.errorMessage;
        urlCheck.status = 'error';
        this.logger.warn({
          event: 'url_check_transport_failed',
          jobId: job.id,
          urlIndex,
          errorType: 'transport',
        });
      }
      this.logger.debug({
        event: 'url_check_result_published',
        jobId: job.id,
        urlIndex,
        state: urlCheck.status,
      });
    } finally {
      releaseRequestPermit();
      urlCheck.completedAt ??= new Date().toISOString();
      urlCheck.durationMs ??= Date.now() - startedAtMilliseconds;
    }
  }

  private acquireRequestPermit(): Promise<() => void> {
    if (this.activeRequestCount < MAX_GLOBAL_CONCURRENT_REQUESTS) {
      this.activeRequestCount += 1;
      return Promise.resolve(() => this.releaseRequestPermit());
    }

    return new Promise((resolve) => {
      this.requestWaiters.push(() => {
        this.activeRequestCount += 1;
        resolve(() => this.releaseRequestPermit());
      });
    });
  }

  private releaseRequestPermit(): void {
    this.activeRequestCount -= 1;
    this.requestWaiters.shift()?.();
  }

  private handleJobProcessingFailure(
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
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const errorStack =
      error instanceof Error ? (error.stack ?? error.message) : String(error);

    if (job.status === 'cancelled') {
      this.logger.warn({
        event: 'job_processing_failure_after_cancellation',
        jobId: job.id,
        failureStage,
        errorName,
      });
    } else {
      job.status = 'failed';
      this.logger.error(
        {
          event: 'job_processing_failed',
          jobId: job.id,
          failureStage,
          errorName,
        },
        errorStack,
      );
    }

    this.terminalizeNonterminalUrlChecks(job);
  }

  private terminalizeNonterminalUrlChecks(job: Job): void {
    const completedAtMilliseconds = Date.now();
    const completedAt = new Date(completedAtMilliseconds).toISOString();

    job.urlChecks.forEach((urlCheck, urlIndex) => {
      if (!['pending', 'in_progress'].includes(urlCheck.status)) return;

      const previousState = urlCheck.status;
      urlCheck.status = 'error';
      urlCheck.errorMessage = INTERNAL_PROCESSING_ERROR_MESSAGE;
      urlCheck.completedAt ??= completedAt;
      if (urlCheck.startedAt && urlCheck.durationMs === undefined) {
        const startedAtMilliseconds = Date.parse(urlCheck.startedAt);
        if (Number.isFinite(startedAtMilliseconds)) {
          urlCheck.durationMs = Math.max(
            0,
            completedAtMilliseconds - startedAtMilliseconds,
          );
        }
      }

      this.logger.debug({
        event: 'url_check_terminalized_after_failure',
        jobId: job.id,
        urlIndex,
        previousState,
        nextState: urlCheck.status,
      });
    });
  }

  private shouldStopProcessing(job: Job): boolean {
    return (
      job.status === 'cancelled' || this.jobsWithProcessingFailure.has(job.id)
    );
  }

  private validateUrls(rawUrls: unknown): string[] {
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
      throw new BadRequestException('urls must be a non-empty array');
    }
    if (rawUrls.length > MAX_URLS_PER_JOB) {
      throw new BadRequestException(
        `A job can contain at most ${MAX_URLS_PER_JOB} URLs`,
      );
    }

    return rawUrls.map((rawUrl) => {
      if (typeof rawUrl !== 'string') {
        throw new BadRequestException('Each URL must be a string');
      }
      const url = rawUrl.trim();
      if (url.length > MAX_URL_LENGTH) {
        throw new BadRequestException(
          `Each URL must be at most ${MAX_URL_LENGTH} characters`,
        );
      }
      try {
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error();
        }
        if (parsedUrl.username || parsedUrl.password) {
          throw new Error();
        }
      } catch {
        throw new BadRequestException(`Invalid HTTP URL: ${url}`);
      }
      return url;
    });
  }

  private ensureJobCapacity(): void {
    const terminalJobs = [...this.jobs.values()]
      .filter((job) => this.isTerminal(job.status))
      .sort((firstJob, secondJob) =>
        firstJob.createdAt.localeCompare(secondJob.createdAt),
      );

    while (this.jobs.size >= MAX_STORED_JOBS && terminalJobs.length > 0) {
      const oldestTerminalJob = terminalJobs.shift();
      if (oldestTerminalJob) this.jobs.delete(oldestTerminalJob.id);
    }

    if (this.jobs.size >= MAX_STORED_JOBS) {
      throw new ServiceUnavailableException(
        'The service is at capacity. Please try again later.',
      );
    }
  }

  private ensureUrlCheckCapacity(requestedUrlCount: number): void {
    const outstandingUrlCount = [...this.jobs.values()].reduce(
      (totalCount, job) =>
        totalCount +
        job.urlChecks.filter(({ status }) =>
          ['pending', 'in_progress'].includes(status),
        ).length,
      0,
    );

    if (outstandingUrlCount + requestedUrlCount > MAX_PENDING_URL_CHECKS) {
      throw new ServiceUnavailableException(
        'The service is at capacity. Please try again later.',
      );
    }
  }

  private getJobOrThrow(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException(`Job ${id} was not found`);
    return job;
  }

  private toSummary(job: Job): JobSummary {
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

  private isTerminal(status: JobStatus): boolean {
    return ['completed', 'cancelled', 'failed'].includes(status);
  }

  private isCancelled(job: Job): boolean {
    return job.status === 'cancelled';
  }
}
