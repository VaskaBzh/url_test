import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import type { ResolvedPublicAddress } from './jobs.types';

interface ResolvedAddressCandidate {
  address: string;
  family: number;
}

type HostnameResolver = (
  hostname: string,
) => Promise<readonly ResolvedAddressCandidate[]>;

const HOSTNAME_RESOLVER = Symbol('HOSTNAME_RESOLVER');

async function resolveHostname(
  hostname: string,
): Promise<readonly ResolvedAddressCandidate[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

/** Signals that a URL resolves to an address outside the allowed public network space. */
export class UnsafeUrlTargetError extends Error {
  constructor() {
    super('URL target is not allowed.');
    this.name = UnsafeUrlTargetError.name;
  }
}

/** Resolves URL hosts and rejects private, local, special-use, or otherwise reserved addresses. */
@Injectable()
export class UrlSafetyService {
  private readonly logger = new Logger(UrlSafetyService.name);

  constructor(
    @Optional()
    @Inject(HOSTNAME_RESOLVER)
    private readonly hostnameResolver: HostnameResolver = resolveHostname,
  ) {}

  /** Resolves every address once, rejects mixed unsafe answers, and returns a request-pinnable address. */
  async resolvePublicAddress(parsedUrl: URL): Promise<ResolvedPublicAddress> {
    const hostname = this.removeIpv6Brackets(parsedUrl.hostname);
    const resolvedAddresses = await this.hostnameResolver(hostname);

    if (resolvedAddresses.length === 0) {
      throw new Error('Hostname did not resolve');
    }

    for (const resolvedAddress of resolvedAddresses) {
      if (!this.isPublicAddress(resolvedAddress.address)) {
        this.logger.warn(
          `[FIX:ssrf] Blocked hostname=${hostname} address=${resolvedAddress.address} range=${this.toAddressRange(resolvedAddress.address)}`,
        );
        throw new UnsafeUrlTargetError();
      }
    }

    const [selectedAddress] = resolvedAddresses;
    if (selectedAddress.family !== 4 && selectedAddress.family !== 6) {
      throw new Error('Hostname resolved to an unsupported address family');
    }
    return {
      address: selectedAddress.address,
      family: selectedAddress.family,
    };
  }

  /** Returns true only for addresses classified as globally routable unicast. */
  isPublicAddress(address: string): boolean {
    try {
      return ipaddr.process(address).range() === 'unicast';
    } catch {
      return false;
    }
  }

  private toAddressRange(address: string): string {
    try {
      return ipaddr.process(address).range();
    } catch {
      return 'invalid';
    }
  }

  private removeIpv6Brackets(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  }
}
