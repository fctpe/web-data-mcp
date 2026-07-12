import { describe, expect, it } from 'vitest';
import { assessQuality } from '../src/core/quality.js';

const SCHEMA = {
  type: 'object',
  required: ['url', 'title'],
  properties: { url: { type: 'string' }, title: { type: 'string', minLength: 1 } },
};

describe('assessQuality', () => {
  it('scores an empty dataset as 0 with an explanatory failure', () => {
    const report = assessQuality([]);
    expect(report.score).toBe(0);
    expect(report.sampleFailures).toEqual(['Dataset is empty.']);
  });

  it('gives a clean, schema-conforming batch a high score', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Page ${index}`,
    }));
    const report = assessQuality(items, { schema: SCHEMA });
    expect(report.schemaPassRate).toBe(1);
    expect(report.duplicateRate).toBe(0);
    expect(report.score).toBeGreaterThan(0.9);
  });

  it('reports schema violations with sample failures', () => {
    const items = [
      { url: 'https://example.com/a', title: 'ok' },
      { url: 'https://example.com/b' },
      { url: 'https://example.com/c' },
    ];
    const report = assessQuality(items, { schema: SCHEMA });
    expect(report.schemaPassRate).toBeCloseTo(1 / 3);
    expect(report.sampleFailures.length).toBe(2);
    expect(report.sampleFailures[0]).toContain('item[1]');
  });

  it('detects duplicates', () => {
    const item = { url: 'https://example.com', title: 'same' };
    const report = assessQuality([item, { ...item }, { ...item }]);
    expect(report.duplicateRate).toBeCloseTo(2 / 3);
  });

  it('flags bot-wall content', () => {
    const report = assessQuality([
      { url: 'https://example.com', text: 'Please verify you are human to continue.' },
    ]);
    expect(report.suspectedBlockRate).toBe(1);
  });

  it('rejects an invalid JSON schema with a clear error', () => {
    expect(() => assessQuality([{ a: 1 }], { schema: { type: 42 } as never })).toThrow(
      /Invalid JSON Schema/,
    );
  });
});
