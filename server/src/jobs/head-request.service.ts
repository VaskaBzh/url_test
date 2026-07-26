import { Injectable, Logger } from '@nestjs/common';
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
import type { HeadRequestOutcome } from './jobs.types';

const REQUEST_TIMEOUT_MILLISECONDS = 15_000;

/**
 * Executes one bounded HEAD request and converts expected transport failures
 * into a typed outcome for the job processor.
 */
@Injectable()
export class HeadRequestService {
  private readonly logger = new Logger(HeadRequestService.name);

  /**
   * Checks a validated HTTP or HTTPS URL without exposing response bodies.
   *
   * Transport and timeout failures resolve as URL-level error outcomes. An
   * unexpected programming or orchestration failure is allowed to reject so
   * the owning job can handle it at its internal error boundary.
   */
  check(url: string): Promise<HeadRequestOutcome> {
    const parsedUrl = new URL(url);
    const requestFactory =
      parsedUrl.protocol === 'https:' ? secureRequest : request;
    const requestContext = {
      event: 'head_request',
      protocol: parsedUrl.protocol.replace(':', ''),
    };

    this.logger.debug({ ...requestContext, state: 'started' });

    return new Promise((resolve) => {
      const clientRequest = requestFactory(
        parsedUrl,
        { method: 'HEAD', timeout: REQUEST_TIMEOUT_MILLISECONDS },
        (response) => {
          response.resume();
          const httpStatus = response.statusCode ?? 0;

          this.logger.debug({
            ...requestContext,
            state: 'completed',
            httpStatus,
          });
          resolve({ kind: 'success', httpStatus });
        },
      );

      clientRequest.once('timeout', () => {
        clientRequest.destroy(new Error('Request timed out'));
      });
      clientRequest.once('error', (error: NodeJS.ErrnoException) => {
        const errorCode = error.code ?? 'TRANSPORT_ERROR';

        this.logger.warn({
          ...requestContext,
          state: 'failed',
          errorCode,
        });
        resolve({
          kind: 'error',
          errorMessage:
            error.message === 'Request timed out'
              ? 'Request timed out'
              : 'URL request failed',
        });
      });
      clientRequest.end();
    });
  }
}
