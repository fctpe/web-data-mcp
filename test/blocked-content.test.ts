/**
 * The headline promise of `scrape_url` is that a blocked scrape is detected and
 * retried with escalating anti-blocking measures. It was not.
 *
 * `suspectedBlockRate` entered the score as a 0.15-weighted term, so the most
 * blocked batch expressible — every page a bot wall — lost exactly 0.15 and
 * scored 0.85 against a 0.70 retry threshold. Blocking could not trigger a
 * retry no matter how total it was. The one fixture that should have caught
 * this ('Access Denied', 13 chars) failed the schema's `minLength: 50` instead,
 * so the escalation test passed on schema failure and block detection was never
 * exercised at all.
 *
 * These tests attack the scorer with the page that defeats it: long enough to
 * pass every other signal, and unmistakably a wall.
 */

import { describe, expect, it } from 'vitest';
import { assessQuality } from '../src/core/quality.js';
import { BLOCKED_PAGE, GOOD_PAGE } from './fake-gateway.js';

/** The schema `scrape_url` applies. Duplicated deliberately: if the tool's copy
 * changes, these numbers should be re-derived rather than silently follow. */
const PAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['url'],
  properties: { url: { type: 'string' } },
  anyOf: [
    { required: ['text'], properties: { text: { type: 'string', minLength: 50 } } },
    { required: ['markdown'], properties: { markdown: { type: 'string', minLength: 50 } } },
  ],
};

const QUALITY_THRESHOLD = 0.7;

describe('bot walls that pass every other quality signal', () => {
  it('the fixture is long enough to clear the schema it used to fail', () => {
    // Without this the tests below silently degrade into minLength tests, which
    // is exactly how the original defect survived review.
    expect(BLOCKED_PAGE.text.length).toBeGreaterThan(50);
    const report = assessQuality([BLOCKED_PAGE], { schema: PAGE_SCHEMA });
    expect(report.schemaPassRate).toBe(1);
    expect(report.fieldCompleteness).toBe(1);
    expect(report.duplicateRate).toBe(0);
  });

  it('detects the wall', () => {
    const report = assessQuality([BLOCKED_PAGE], { schema: PAGE_SCHEMA });
    expect(report.suspectedBlockRate).toBe(1);
  });

  it('scores a fully blocked batch below the retry threshold', () => {
    const report = assessQuality([BLOCKED_PAGE], { schema: PAGE_SCHEMA });
    // Was 0.85 — schema 0.4 + completeness 0.3 + non-duplicate 0.15 + blocked 0.
    expect(report.score).toBeLessThan(QUALITY_THRESHOLD);
    expect(report.score).toBe(0);
  });

  it('scores a batch of many distinct walls below the threshold too', () => {
    // Distinct urls, so the duplicate signal cannot be what rescues the score.
    const items = Array.from({ length: 10 }, (_, index) => ({
      ...BLOCKED_PAGE,
      url: `https://example.com/page-${index}`,
    }));
    const report = assessQuality(items, { schema: PAGE_SCHEMA });
    expect(report.duplicateRate).toBe(0);
    expect(report.suspectedBlockRate).toBe(1);
    expect(report.score).toBeLessThan(QUALITY_THRESHOLD);
  });

  it('caps a partially blocked batch at the fraction that is real content', () => {
    const items = [
      ...Array.from({ length: 3 }, (_, i) => ({ ...GOOD_PAGE, url: `https://example.com/${i}` })),
      { ...BLOCKED_PAGE, url: 'https://example.com/blocked' },
    ];
    const report = assessQuality(items, { schema: PAGE_SCHEMA });
    expect(report.suspectedBlockRate).toBe(0.25);
    expect(report.score).toBeLessThanOrEqual(0.75);
  });

  it('leaves a clean batch untouched by the ceiling', () => {
    // Negative control: the fix must not depress scores for pages that are fine,
    // or every scrape starts retrying and the ceiling is just a tax.
    const items = Array.from({ length: 5 }, (_, i) => ({
      ...GOOD_PAGE,
      url: `https://example.com/${i}`,
    }));
    const report = assessQuality(items, { schema: PAGE_SCHEMA });
    expect(report.suspectedBlockRate).toBe(0);
    expect(report.score).toBeGreaterThanOrEqual(QUALITY_THRESHOLD);
  });

  it('catches each block marker the scorer claims to know', () => {
    const markers = [
      'Access Denied. You do not have permission to view this page on this server today.',
      'Please complete the captcha below to continue browsing this website as a human being.',
      'Verify you are human by completing the challenge shown below before we let you through.',
      'Please enable JavaScript to continue. This site requires scripting to render its content.',
      'Are you a robot? We need to check before you continue to the requested page content here.',
      'Unusual traffic from your network has been detected, so we have paused your access today.',
      'Attention Required! Your request was blocked by the security service protecting this site.',
    ];
    for (const text of markers) {
      const report = assessQuality([{ url: 'https://example.com/x', text }], {
        schema: PAGE_SCHEMA,
      });
      expect(report.suspectedBlockRate, `marker not detected: ${text.slice(0, 30)}`).toBe(1);
      expect(report.score).toBeLessThan(QUALITY_THRESHOLD);
    }
  });
});
