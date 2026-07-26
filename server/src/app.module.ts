import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { minutes, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HeadRequestService } from './jobs/head-request.service';
import { JobsController } from './jobs/jobs.controller';
import { JobsService } from './jobs/jobs.service';
import { ResultDelayService } from './jobs/result-delay.service';
import { UrlSafetyService } from './jobs/url-safety.service';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      errorMessage: 'Too many requests. Please try again later.',
      throttlers: [{ ttl: minutes(1), limit: 120 }],
    }),
  ],
  controllers: [JobsController],
  providers: [
    HeadRequestService,
    JobsService,
    ResultDelayService,
    UrlSafetyService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
