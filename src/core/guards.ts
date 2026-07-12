import { WebDataError } from './errors.js';

const PRIVATE_IPV4_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
];

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  ...PRIVATE_IPV4_PATTERNS,
  /^\[?::1?\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

/** IPv4-mapped IPv6 must be judged by its IPv4 part. WHATWG URLs canonicalize
 *  [::ffff:127.0.0.1] to the hex form [::ffff:7f00:1], so both are handled. */
const IPV4_MAPPED_DOTTED = /^\[?::ffff:((?:\d{1,3}\.){3}\d{1,3})\]?$/i;
const IPV4_MAPPED_HEX = /^\[?::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]?$/i;

function mappedIpv4(hostname: string): string | null {
  const dotted = IPV4_MAPPED_DOTTED.exec(hostname);
  if (dotted?.[1]) return dotted[1];
  const hex = IPV4_MAPPED_HEX.exec(hostname);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return null;
}

function isPrivateHost(hostname: string): boolean {
  const ipv4 = mappedIpv4(hostname);
  if (ipv4) {
    return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(ipv4));
  }
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

/**
 * Rejects non-http(s) schemes and private/loopback hosts so an agent cannot
 * point a scraper at internal infrastructure.
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebDataError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebDataError(
      `Unsupported URL scheme "${url.protocol}" — only http and https are allowed.`,
    );
  }
  if (isPrivateHost(url.hostname)) {
    throw new WebDataError(`Refusing to scrape private or local host "${url.hostname}".`);
  }
  return url;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function assertAllowedActor(actorId: string, allowlist: readonly string[]): void {
  if (!allowlist.includes(actorId)) {
    throw new WebDataError(
      `Actor "${actorId}" is not on the allowlist. Allowed actors: ${allowlist.join(', ')}. ` +
        'Extend the list via the WEB_DATA_MCP_ALLOWED_ACTORS environment variable.',
    );
  }
}
