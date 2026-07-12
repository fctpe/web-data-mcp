import { describe, expect, it } from 'vitest';
import { paginationInfo } from '../src/tools/helpers.js';

describe('paginationInfo', () => {
  it('treats the fetched page as a floor when the reported total lags behind', () => {
    const { effectiveTotal, nextOffset } = paginationInfo({ offset: 0, count: 3, total: 0 }, 50);
    expect(effectiveTotal).toBe(3);
    expect(nextOffset).toBeNull();
  });

  it('assumes more pages exist after a full page even with a lagging total', () => {
    const { nextOffset } = paginationInfo({ offset: 0, count: 50, total: 0 }, 50);
    expect(nextOffset).toBe(50);
  });

  it('paginates normally against an accurate total', () => {
    expect(paginationInfo({ offset: 0, count: 50, total: 120 }, 50).nextOffset).toBe(50);
    expect(paginationInfo({ offset: 100, count: 20, total: 120 }, 50).nextOffset).toBeNull();
  });

  it('reports no continuation for an empty dataset', () => {
    const { effectiveTotal, nextOffset } = paginationInfo({ offset: 0, count: 0, total: 0 }, 50);
    expect(effectiveTotal).toBe(0);
    expect(nextOffset).toBeNull();
  });
});
