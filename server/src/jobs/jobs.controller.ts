import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { minutes, Throttle } from '@nestjs/throttler';
import type { CreateJobDto } from './dto/create-job.dto';
import { JobsService } from './jobs.service';

/** HTTP endpoints for creating, inspecting, and cancelling URL checking jobs. */
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  /** Creates a job and starts its background processing. */
  @Post()
  @Throttle({ default: { ttl: minutes(1), limit: 5 } })
  create(@Body() createJobDto: CreateJobDto) {
    return this.jobsService.create(createJobDto.urls);
  }

  /** Lists all jobs, newest first, with aggregate statistics. */
  @Get()
  findAll() {
    return this.jobsService.findAll();
  }

  /** Returns the URL-level result data for one job. */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.jobsService.findOne(id);
  }

  /** Cancels a job and prevents any URLs not yet started from running. */
  @Delete(':id')
  @HttpCode(204)
  cancel(@Param('id') id: string): void {
    this.jobsService.cancel(id);
  }
}
