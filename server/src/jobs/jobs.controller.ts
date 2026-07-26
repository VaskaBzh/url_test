import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import type { CreateJobDto } from './dto/create-job.dto';
import type {
  CreateJobResponse,
  JobDetailsResponse,
  JobSummaryResponse,
} from './jobs.contracts';
import { CreateJobValidationPipe } from './pipes/create-job-validation.pipe';
import { JobsService } from './jobs.service';

/** HTTP endpoints for creating, inspecting, and cancelling URL-checking jobs. */
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  /** Creates a job and starts its background processing. */
  @Post()
  create(
    @Body(CreateJobValidationPipe) createJobDto: CreateJobDto,
  ): CreateJobResponse {
    return this.jobsService.create(createJobDto.urls);
  }

  /** Lists all jobs, newest first, with aggregate statistics. */
  @Get()
  findAll(): readonly JobSummaryResponse[] {
    return this.jobsService.findAll();
  }

  /** Returns the URL-level result data for one job. */
  @Get(':id')
  findOne(@Param('id') id: string): JobDetailsResponse {
    return this.jobsService.findOne(id);
  }

  /** Cancels a job and prevents any URLs not yet started from running. */
  @Delete(':id')
  @HttpCode(204)
  cancel(@Param('id') id: string): void {
    this.jobsService.cancel(id);
  }
}
