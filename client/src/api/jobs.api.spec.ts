import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelJob, createJob, getJobs } from './jobs.api';

describe('jobs API error normalization', () => {
  const mockedFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockedFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [400, 'The submitted request is invalid.'],
    [404, 'The requested job was not found.'],
    [429, 'Too many requests. Please wait and try again.'],
    [500, 'The service is temporarily unavailable. Please try again.'],
  ])(
    'maps HTTP %i without exposing the response body',
    async (httpStatus, expectedMessage) => {
      mockedFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            message: 'connect ECONNREFUSED 10.0.0.1:6379 secret=value',
          }),
          { status: httpStatus },
        ),
      );

      await expect(getJobs()).rejects.toThrow(expectedMessage);
      await expect(getJobs()).rejects.not.toThrow('ECONNREFUSED');
    },
  );

  it('maps transport failures to a stable message', async () => {
    mockedFetch.mockRejectedValue(new Error('Failed to fetch internal details'));

    await expect(createJob(['https://example.com'])).rejects.toThrow(
      'Unable to reach the service. Please try again.',
    );
  });

  it('maps malformed successful responses to a stable message', async () => {
    mockedFetch.mockResolvedValue(new Response('not-json', { status: 200 }));

    await expect(getJobs()).rejects.toThrow(
      'The service returned an invalid response.',
    );
  });

  it('handles successful empty cancellation responses', async () => {
    mockedFetch.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(cancelJob('job-1')).resolves.toBeUndefined();
  });
});
