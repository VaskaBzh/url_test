import { Injectable, Logger } from '@nestjs/common';

const MAXIMUM_RESULT_DELAY_MILLISECONDS = 10_000;

/** Applies the artificial publication delay required by the job contract. */
@Injectable()
export class ResultDelayService {
  private readonly logger = new Logger(ResultDelayService.name);

  /**
   * Waits for a uniformly selected delay from zero through ten seconds.
   *
   * The selected duration is logged at DEBUG and can be hidden in production
   * by lowering the configured Nest log level.
   */
  async wait(): Promise<void> {
    const delayMilliseconds = Math.floor(
      Math.random() * (MAXIMUM_RESULT_DELAY_MILLISECONDS + 1),
    );

    this.logger.debug({
      event: 'result_delay',
      state: 'started',
      delayMilliseconds,
    });
    await new Promise<void>((resolve) =>
      setTimeout(resolve, delayMilliseconds),
    );
    this.logger.debug({
      event: 'result_delay',
      state: 'completed',
      delayMilliseconds,
    });
  }
}
