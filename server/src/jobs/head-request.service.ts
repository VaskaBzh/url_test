import { Injectable, Logger } from '@nestjs/common';
import { request, type RequestOptions } from 'node:http';
import { request as secureRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { HeadRequestOutcome } from './jobs.types';
import { UnsafeUrlTargetError, UrlSafetyService } from './url-safety.service';

const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const MAXIMUM_HEADER_BYTES = 16_384;

class UrlRequestTimeoutError extends Error {
  constructor() {
    super('Request timed out.');
    this.name = UrlRequestTimeoutError.name;
  }
}

/**
 * Executes one bounded HEAD request and converts expected transport failures
 * into a typed outcome for the job processor.
 */
@Injectable()
export class HeadRequestService {
  private readonly logger = new Logger(HeadRequestService.name);

  constructor(private readonly urlSafetyService: UrlSafetyService) {}

  /**
   * Checks a validated HTTP or HTTPS URL without exposing response bodies.
   *
   * URL-safety, DNS, transport, and timeout failures resolve as URL-level error
   * outcomes so the caller never persists low-level network details.
   */
  async check(url: string): Promise<HeadRequestOutcome> {
    const parsedUrl = new URL(url);
    const requestContext = {
      event: 'head_request',
      hostname: parsedUrl.hostname,
      protocol: parsedUrl.protocol.replace(':', ''),
    };

    this.logger.debug({ ...requestContext, state: 'started' });

    try {
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
        maxHeaderSize: MAXIMUM_HEADER_BYTES,
        method: 'HEAD',
        timeout: REQUEST_TIMEOUT_MILLISECONDS,
      };

      return await new Promise((resolve) => {
        const requestFactory =
          parsedUrl.protocol === 'https:' ? secureRequest : request;
        const clientRequest = requestFactory(
          parsedUrl,
          requestOptions,
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
          clientRequest.destroy(new UrlRequestTimeoutError());
        });
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
        clientRequest.once('error', (error: NodeJS.ErrnoException) => {
          const errorName = error.name || 'UnknownError';
          const errorCode = error.code ?? 'TRANSPORT_ERROR';
          this.logger.warn({
            ...requestContext,
            state: 'failed',
            errorCode,
            errorName,
          });
          resolve({
            kind: 'error',
            errorMessage: this.toSafeErrorMessage(error),
          });
        });
        clientRequest.end();
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn({
        ...requestContext,
        state: 'failed_before_request',
        errorName,
      });
      return {
        kind: 'error',
        errorMessage: this.toSafeErrorMessage(error),
      };
    }
  }

  private toSafeErrorMessage(error: unknown): string {
    if (error instanceof UnsafeUrlTargetError) {
      return 'URL target is not allowed.';
    }
    if (error instanceof UrlRequestTimeoutError) {
      return 'Request timed out.';
    }
    return 'Unable to reach URL.';
  }
}
