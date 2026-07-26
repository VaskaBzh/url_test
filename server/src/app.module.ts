import { Module } from '@nestjs/common';
import { HeadRequestService } from './jobs/head-request.service';
import { JobsController } from './jobs/jobs.controller';
import { JobsService } from './jobs/jobs.service';
import { ResultDelayService } from './jobs/result-delay.service';

@Module({
  imports: [],
  controllers: [JobsController],
  providers: [HeadRequestService, JobsService, ResultDelayService],
})
export class AppModule {}
