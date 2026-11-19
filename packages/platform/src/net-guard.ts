import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Server-side request forgery protection for partner-supplied URLs (webhook endpoints).
 * In production, targets must use HTTPS and must not resolve to loopback, private, link-local,
 * carrier-grade NAT or other internal ranges. The check runs when a URL is registered and again
 * at every delivery (DNS can change).
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export interface TargetPolicy {
  /** Allows http:// and internal addresses. Only for local development and tests. */
  allowPrivate: boolean;
}

export class UnsafeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTargetError';
  }
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/** Synchronous checks on the URL itself. Returns the parsed URL. */
export function checkTargetUrl(raw: string, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTargetError('The URL is not valid.');
  }
  if (url.username || url.password)
    throw new UnsafeTargetError('The URL must not contain credentials.');
  if (policy.allowPrivate) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new UnsafeTargetError('The URL must use http or https.');
    }
    return url;
  }
  if (url.protocol !== 'https:') throw new UnsafeTargetError('The URL must use https.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new UnsafeTargetError('The URL must not point to an internal host.');
  }
  if (isIP(host) && isBlockedAddress(host)) {
    throw new UnsafeTargetError('The URL must not point to a private or reserved address.');
  }
  return url;
}

/** Resolves the host and rejects it if any resolved address is internal. */
export async function checkTargetResolves(raw: string, policy: TargetPolicy): Promise<void> {
  const url = checkTargetUrl(raw, policy);
  if (policy.allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0) throw new UnsafeTargetError('The host did not resolve.');
  for (const a of addresses) {
    if (isBlockedAddress(a.address)) {
      throw new UnsafeTargetError('The host resolves to a private or reserved address.');
    }
  }
}
