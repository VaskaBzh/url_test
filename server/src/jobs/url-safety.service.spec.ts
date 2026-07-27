import { UnsafeUrlTargetError, UrlSafetyService } from './url-safety.service';

describe('UrlSafetyService', () => {
  it.each([
    ['127.0.0.1', 4],
    ['10.0.0.1', 4],
    ['100.64.0.1', 4],
    ['169.254.1.1', 4],
    ['192.0.2.1', 4],
    ['::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['2001:db8::1', 6],
    ['::ffff:127.0.0.1', 6],
  ])('rejects non-public address %s', async (address, family) => {
    const hostnameResolver = jest.fn().mockResolvedValue([{ address, family }]);
    const service = new UrlSafetyService(hostnameResolver);

    await expect(
      service.resolvePublicAddress(new URL('https://example.com')),
    ).rejects.toBeInstanceOf(UnsafeUrlTargetError);
  });

  it('rejects a hostname when any DNS answer is non-public', async () => {
    const hostnameResolver = jest.fn().mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const service = new UrlSafetyService(hostnameResolver);

    await expect(
      service.resolvePublicAddress(new URL('https://example.com')),
    ).rejects.toBeInstanceOf(UnsafeUrlTargetError);
    expect(hostnameResolver).toHaveBeenCalledTimes(1);
  });

  it('returns one pinnable address after validating every DNS answer', async () => {
    const hostnameResolver = jest.fn().mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]);
    const service = new UrlSafetyService(hostnameResolver);

    await expect(
      service.resolvePublicAddress(new URL('https://example.com')),
    ).resolves.toEqual({ address: '8.8.8.8', family: 4 });
    expect(hostnameResolver).toHaveBeenCalledWith('example.com');
    expect(hostnameResolver).toHaveBeenCalledTimes(1);
  });

  it('removes URL brackets before resolving an IPv6 literal', async () => {
    const hostnameResolver = jest
      .fn()
      .mockResolvedValue([{ address: '::1', family: 6 }]);
    const service = new UrlSafetyService(hostnameResolver);

    await expect(
      service.resolvePublicAddress(new URL('http://[::1]')),
    ).rejects.toBeInstanceOf(UnsafeUrlTargetError);
    expect(hostnameResolver).toHaveBeenCalledWith('::1');
  });
});
