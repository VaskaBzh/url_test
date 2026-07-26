import {
  BadRequestException,
  Injectable,
  Logger,
  PipeTransform,
} from '@nestjs/common';
import type { CreateJobDto } from '../dto/create-job.dto';

const MAXIMUM_URL_COUNT = 100;
const MAXIMUM_URL_LENGTH = 2_048;
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

interface ValidationLogContext {
  readonly rule: string;
  readonly urlCount?: number;
  readonly urlIndex?: number;
}

/**
 * Converts an untrusted create-job body into a normalized DTO.
 *
 * Unknown top-level fields are ignored for backward compatibility. Rejection
 * messages and logs intentionally omit submitted URL values because they may
 * contain credentials or sensitive query parameters.
 */
@Injectable()
export class CreateJobValidationPipe implements PipeTransform<
  unknown,
  CreateJobDto
> {
  private readonly logger = new Logger(CreateJobValidationPipe.name);

  /** Validates the request body and preserves submitted URL order and duplicates. */
  transform(rawPayload: unknown): CreateJobDto {
    if (!this.isObjectPayload(rawPayload)) {
      this.rejectPayload('body_object', 'body must be an object');
    }

    const rawUrls = rawPayload.urls;
    if (!Array.isArray(rawUrls)) {
      this.rejectPayload('urls_array', 'urls must be an array');
    }
    if (rawUrls.length === 0) {
      this.rejectPayload(
        'urls_minimum_count',
        'urls must contain at least one item',
        { urlCount: rawUrls.length },
      );
    }
    if (rawUrls.length > MAXIMUM_URL_COUNT) {
      this.rejectPayload(
        'urls_maximum_count',
        `urls must contain at most ${MAXIMUM_URL_COUNT} items`,
        { urlCount: rawUrls.length },
      );
    }

    const normalizedUrls = rawUrls.map((rawUrl, urlIndex) =>
      this.normalizeUrl(rawUrl, urlIndex, rawUrls.length),
    );
    this.logger.debug(
      `[CreateJobValidationPipe.transform] payload accepted ${JSON.stringify({
        urlCount: normalizedUrls.length,
      })}`,
    );

    return { urls: normalizedUrls };
  }

  private normalizeUrl(
    rawUrl: unknown,
    urlIndex: number,
    urlCount: number,
  ): string {
    if (typeof rawUrl !== 'string') {
      this.rejectPayload('url_string', `urls[${urlIndex}] must be a string`, {
        urlIndex,
        urlCount,
      });
    }

    const normalizedUrl = rawUrl.trim();
    if (normalizedUrl.length === 0) {
      this.rejectPayload(
        'url_non_empty',
        `urls[${urlIndex}] must not be blank`,
        { urlIndex, urlCount },
      );
    }
    if (normalizedUrl.length > MAXIMUM_URL_LENGTH) {
      this.rejectPayload(
        'url_maximum_length',
        `urls[${urlIndex}] must contain at most ${MAXIMUM_URL_LENGTH} characters`,
        { urlIndex, urlCount },
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      this.rejectPayload(
        'url_absolute',
        `urls[${urlIndex}] must be an absolute URL`,
        { urlIndex, urlCount },
      );
    }

    if (!SUPPORTED_PROTOCOLS.has(parsedUrl.protocol)) {
      this.rejectPayload(
        'url_protocol',
        `urls[${urlIndex}] must use http or https`,
        { urlIndex, urlCount },
      );
    }

    return normalizedUrl;
  }

  private isObjectPayload(
    rawPayload: unknown,
  ): rawPayload is Record<string, unknown> {
    return (
      typeof rawPayload === 'object' &&
      rawPayload !== null &&
      !Array.isArray(rawPayload)
    );
  }

  private rejectPayload(
    rule: string,
    message: string,
    context: Omit<ValidationLogContext, 'rule'> = {},
  ): never {
    this.logger.warn(
      `[CreateJobValidationPipe.transform] payload rejected ${JSON.stringify({
        rule,
        ...context,
      })}`,
    );
    throw new BadRequestException(message);
  }
}
