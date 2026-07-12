import { WebDataError } from './errors.js';

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

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
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
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
