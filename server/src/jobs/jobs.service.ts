import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { Job, JobStatus, JobSummary, UrlCheck } from './jobs.types';

const MAX_CONCURRENT_CHECKS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESULT_DELAY_MS = 10_000;

/**
 * Stores jobs in memory and executes URL checks in independent, bounded queues.
 * Jobs are intentionally process-local: restarting the server clears their history.
 */
@Injectable()
export class JobsService {
  private readonly jobs = new Map<string, Job>();

  /** Validates submitted URLs, stores the job, and schedules its non-blocking processor. */
  create(rawUrls: unknown): { jobId: string } {
    const urls = this.validateUrls(rawUrls);
    const job: Job = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      urlChecks: urls.map((url) => ({ url, status: 'pending' })),
    };

    this.jobs.set(job.id, job);
    void this.processJob(job);
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
        { length: Math.min(MAX_CONCURRENT_CHECKS, job.urlChecks.length) },
        worker,
      ),
    );
    if (!this.wasCancelled(job)) job.status = 'completed';
  }

  private async processUrlCheck(job: Job, urlCheck: UrlCheck): Promise<void> {
    if (job.status === 'cancelled') {
      urlCheck.status = 'cancelled';
      return;
    }

    urlCheck.status = 'in_progress';
    urlCheck.startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    try {
      urlCheck.httpStatus = await this.performHeadRequest(urlCheck.url);
      await this.delayResult();
      urlCheck.status = 'success';
    } catch (error: unknown) {
      await this.delayResult();
      urlCheck.status = 'error';
      urlCheck.errorMessage =
        error instanceof Error ? error.message : 'Unexpected request error';
    } finally {
      urlCheck.completedAt = new Date().toISOString();
      urlCheck.durationMs = Date.now() - startedAtMs;
    }
  }

  private performHeadRequest(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const requestFactory =
        parsedUrl.protocol === 'https:' ? secureRequest : request;
      const clientRequest = requestFactory(
        parsedUrl,
        { method: 'HEAD', timeout: REQUEST_TIMEOUT_MS },
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
    const delayMs = Math.floor(Math.random() * (MAX_RESULT_DELAY_MS + 1));
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private validateUrls(rawUrls: unknown): string[] {
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
      throw new BadRequestException('urls must be a non-empty array');
    }

    return rawUrls.map((rawUrl) => {
      if (typeof rawUrl !== 'string')
        throw new BadRequestException('Each URL must be a string');
      const url = rawUrl.trim();
      try {
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol))
          throw new Error();
      } catch {
        throw new BadRequestException(`Invalid HTTP URL: ${url}`);
      }
      return url;
    });
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

  private wasCancelled(job: Job): boolean {
    return job.status === 'cancelled';
  }
}
