import { BadRequestException } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { UrlSafetyService } from './url-safety.service';

describe('JobsService security boundaries', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects jobs that exceed the per-job URL limit', () => {
    const urlSafetyService = {
      resolvePublicAddress: jest.fn(),
    } as unknown as UrlSafetyService;
    const jobsService = new JobsService(urlSafetyService);
    const urls = Array.from(
      { length: 51 },
      (_, index) => `https://example-${index}.com`,
    );

    expect(() => jobsService.create(urls)).toThrow(BadRequestException);
  });

  it('never exposes a low-level network error in job details', async () => {
    const urlSafetyService = {
      resolvePublicAddress: jest
        .fn()
        .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:6379')),
    } as unknown as UrlSafetyService;
    const jobsService = new JobsService(urlSafetyService);
    jest.spyOn(Math, 'random').mockReturnValue(0);

    const { jobId } = jobsService.create(['https://example.com']);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const [urlCheck] = jobsService.findOne(jobId).urlChecks;
    expect(urlCheck.status).toBe('error');
    expect(urlCheck.errorMessage).toBe('Unable to reach URL.');
    expect(urlCheck.errorMessage).not.toContain('10.0.0.1');
    expect(urlCheck.errorMessage).not.toContain('ECONNREFUSED');
  });
});
