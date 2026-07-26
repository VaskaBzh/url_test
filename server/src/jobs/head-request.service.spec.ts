import { HeadRequestService } from './head-request.service';
import { UnsafeUrlTargetError, UrlSafetyService } from './url-safety.service';

describe('HeadRequestService safety mapping', () => {
  it('returns a safe error when URL safety rejects a private target', async () => {
    const urlSafetyService = {
      isPublicAddress: jest.fn(),
      resolvePublicAddress: jest
        .fn()
        .mockRejectedValue(new UnsafeUrlTargetError()),
    } as unknown as UrlSafetyService;
    const headRequestService = new HeadRequestService(urlSafetyService);

    await expect(
      headRequestService.check('https://example.com'),
    ).resolves.toEqual({
      kind: 'error',
      errorMessage: 'URL target is not allowed.',
    });
  });

  it('does not expose low-level resolver failure details', async () => {
    const urlSafetyService = {
      isPublicAddress: jest.fn(),
      resolvePublicAddress: jest
        .fn()
        .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:6379')),
    } as unknown as UrlSafetyService;
    const headRequestService = new HeadRequestService(urlSafetyService);

    const result = await headRequestService.check('https://example.com');

    expect(result).toEqual({
      kind: 'error',
      errorMessage: 'Unable to reach URL.',
    });
    if (result.kind === 'error') {
      expect(result.errorMessage).not.toContain('10.0.0.1');
      expect(result.errorMessage).not.toContain('ECONNREFUSED');
    }
  });
});
