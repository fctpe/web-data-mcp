import { describe, expect, it } from 'vitest';
import { assertAllowedActor, assertSafeUrl, clamp } from '../src/core/guards.js';

describe('assertSafeUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(assertSafeUrl('https://example.com/page').hostname).toBe('example.com');
    expect(assertSafeUrl('http://sub.example.org').hostname).toBe('sub.example.org');
  });

  it.each([
    'ftp://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])('rejects non-http scheme %s', (url) => {
    expect(() => assertSafeUrl(url)).toThrow(/scheme|Invalid/);
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://10.0.0.5',
    'http://172.16.1.1',
    'http://192.168.1.1',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8080',
    'http://printer.local',
    'http://service.internal',
  ])('rejects private/loopback host %s', (url) => {
    expect(() => assertSafeUrl(url)).toThrow(/private or local/);
  });

  it('rejects garbage', () => {
    expect(() => assertSafeUrl('not a url')).toThrow(/Invalid URL/);
  });
});

describe('clamp', () => {
  it('clamps into range', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-5, 1, 10)).toBe(1);
    expect(clamp(50, 1, 10)).toBe(10);
  });
});

describe('assertAllowedActor', () => {
  it('accepts allowlisted actors and rejects others with guidance', () => {
    expect(() => assertAllowedActor('apify/hello-world', ['apify/hello-world'])).not.toThrow();
    expect(() => assertAllowedActor('evil/actor', ['apify/hello-world'])).toThrow(
      /not on the allowlist.*WEB_DATA_MCP_ALLOWED_ACTORS/s,
    );
  });
});
