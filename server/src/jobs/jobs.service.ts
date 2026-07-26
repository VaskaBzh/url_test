import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { request, type RequestOptions } from 'node:http';
import { request as secureRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Job, JobStatus, JobSummary, UrlCheck } from './jobs.types';
import { UnsafeUrlTargetError, UrlSafetyService } from './url-safety.service';

const MAX_CONCURRENT_CHECKS_PER_JOB = 5;
const MAX_GLOBAL_CONCURRENT_REQUESTS = 20;
const MAX_PENDING_URL_CHECKS = 1_000;
const MAX_STORED_JOBS = 100;
const MAX_URLS_PER_JOB = 50;
const MAX_URL_LENGTH = 2_048;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESULT_DELAY_MS = 10_000;

class UrlRequestTimeoutError extends Error {
  constructor() {
    super('Request timed out.');
    this.name = UrlRequestTimeoutError.name;
  }
}

/**
 * Stores jobs in memory and executes URL checks within process-wide resource limits.
 * Jobs are intentionally process-local: restarting the server clears their history.
 */
@Injectable()
export class JobsService {
  private readonly jobs = new Map<string, Job>();
  private readonly logger = new Logger(JobsService.name);
  private activeRequestCount = 0;
  private readonly requestWaiters: Array<() => void> = [];

  constructor(private readonly urlSafetyService: UrlSafetyService) {}

  /** Validates submitted URLs, reserves bounded capacity, and schedules background processing. */
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
    this.logAcceptedJob(job);
    void this.processJob(job).catch((error: unknown) => {
      job.status = 'failed';
      this.logger.error(
        `[FIX:resource-limits] Job processor failed jobId=${job.id} reason=${this.toErrorReason(error)}`,
      );
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
    if (this.isTerminal(job.status)) return;

    job.status = 'cancelled';
    for (const urlCheck of job.urlChecks) {
      if (urlCheck.status === 'pending') urlCheck.status = 'cancelled';
    }
  }

  private async processJob(job: Job): Promise<void> {
    if (job.status === 'cancelled') return;
    job.status = 'in_progress';
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        if (job.status === 'cancelled') return;
        const urlCheck = job.urlChecks[nextIndex++];
        if (!urlCheck) return;
        await this.processUrlCheck(job, urlCheck);
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(MAX_CONCURRENT_CHECKS_PER_JOB, job.urlChecks.length),
        },
        worker,
      ),
    );
    if (!this.wasCancelled(job)) job.status = 'completed';
  }

  private async processUrlCheck(job: Job, urlCheck: UrlCheck): Promise<void> {
    const releaseRequestPermit = await this.acquireRequestPermit();
    if (job.status === 'cancelled') {
      urlCheck.status = 'cancelled';
      releaseRequestPermit();
      return;
    }

    urlCheck.status = 'in_progress';
    urlCheck.startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    try {
      urlCheck.httpStatus = await this.performHeadRequest(urlCheck.url);
      urlCheck.status = 'success';
    } catch (error: unknown) {
      urlCheck.status = 'error';
      urlCheck.errorMessage = this.toSafeUrlErrorMessage(error);
      this.logUrlCheckFailure(job.id, urlCheck.url, error);
    } finally {
      releaseRequestPermit();
    }

    await this.delayResult();
    urlCheck.completedAt = new Date().toISOString();
    urlCheck.durationMs = Date.now() - startedAtMs;
  }

  private async performHeadRequest(url: string): Promise<number> {
    const parsedUrl = new URL(url);
    const resolvedAddress =
      await this.urlSafetyService.resolvePublicAddress(parsedUrl);
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [resolvedAddress]);
        return;
      }
      callback(null, resolvedAddress.address, resolvedAddress.family);
    };
    const requestOptions: RequestOptions = {
      agent: false,
      lookup: pinnedLookup,
      maxHeaderSize: 16_384,
      method: 'HEAD',
      timeout: REQUEST_TIMEOUT_MS,
    };

    return new Promise((resolve, reject) => {
      const requestFactory =
        parsedUrl.protocol === 'https:' ? secureRequest : request;
      const clientRequest = requestFactory(
        parsedUrl,
        requestOptions,
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      clientRequest.once('timeout', () =>
        clientRequest.destroy(new UrlRequestTimeoutError()),
      );
      clientRequest.once('socket', (socket) => {
        socket.once('connect', () => {
          const remoteAddress = socket.remoteAddress;
          if (
            !remoteAddress ||
            !this.urlSafetyService.isPublicAddress(remoteAddress)
          ) {
            clientRequest.destroy(new UnsafeUrlTargetError());
          }
        });
      });
      clientRequest.once('error', reject);
      clientRequest.end();
    });
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

  private async delayResult(): Promise<void> {
    const delayMs = Math.floor(Math.random() * (MAX_RESULT_DELAY_MS + 1));
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private validateUrls(rawUrls: unknown): string[] {
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
      throw new BadRequestException('urls must be a non-empty array');
    }
    if (rawUrls.length > MAX_URLS_PER_JOB) {
      this.logger.warn(
        `[FIX:resource-limits] Rejected URL count=${rawUrls.length} limit=${MAX_URLS_PER_JOB}`,
      );
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
      this.rejectForCapacity('stored jobs');
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
      this.rejectForCapacity('pending URL checks');
    }
  }

  private rejectForCapacity(resourceName: string): never {
    this.logger.warn(
      `[FIX:resource-limits] Rejected job because ${resourceName} reached capacity`,
    );
    throw new ServiceUnavailableException(
      'The service is at capacity. Please try again later.',
    );
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

  private toSafeUrlErrorMessage(error: unknown): string {
    if (error instanceof UnsafeUrlTargetError) {
      return 'URL target is not allowed.';
    }
    if (error instanceof UrlRequestTimeoutError) {
      return 'Request timed out.';
    }
    return 'Unable to reach URL.';
  }

  private logUrlCheckFailure(jobId: string, url: string, error: unknown): void {
    const hostname = new URL(url).hostname;
    this.logger.warn(
      `[FIX:url-check] Check failed jobId=${jobId} hostname=${hostname} reason=${this.toErrorReason(error)}`,
    );
  }

  private toErrorReason(error: unknown): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      return error.code;
    }
    return error instanceof Error ? error.name : 'UnknownError';
  }

  private logAcceptedJob(job: Job): void {
    if (
      process.env.DEBUG_FIX !== '1' &&
      process.env.LOG_LEVEL?.toLowerCase() !== 'debug'
    ) {
      return;
    }
    this.logger.debug(
      `[FIX:resource-limits] Accepted jobId=${job.id} urlCount=${job.urlChecks.length}`,
    );
  }

  private isTerminal(status: JobStatus): boolean {
    return ['completed', 'cancelled', 'failed'].includes(status);
  }

  private wasCancelled(job: Job): boolean {
    return job.status === 'cancelled';
  }
}
