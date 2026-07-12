import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/core/chunker.js';
import { countTokens } from '../src/core/tokens.js';

const PARAGRAPH =
  'The quick brown fox jumps over the lazy dog near the quiet river bank every single morning. ';

describe('chunkText', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkText('   \n\n  ', { maxTokens: 100, overlapTokens: 10 })).toEqual([]);
  });

  it('keeps a short text as one chunk', () => {
    const chunks = chunkText('Hello world.', { maxTokens: 100, overlapTokens: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('Hello world.');
  });

  it('never exceeds the token bound', () => {
    const text = Array.from({ length: 30 }, () => PARAGRAPH).join('\n\n');
    const chunks = chunkText(text, { maxTokens: 80, overlapTokens: 16 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(80 + 16);
      expect(countTokens(chunk.content)).toBe(chunk.tokenCount);
    }
  });

  it('carries token overlap between adjacent chunks', () => {
    const text = Array.from({ length: 20 }, (_, index) => `Sentence number ${index} here.`).join(
      '\n\n',
    );
    const chunks = chunkText(text, { maxTokens: 40, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0];
    const second = chunks[1];
    expect(first && second?.content.includes(first.content.slice(-12))).toBe(true);
  });

  it('splits a single oversized sentence by tokens', () => {
    const word = 'independently ';
    const chunks = chunkText(word.repeat(200), { maxTokens: 50, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(50);
    }
  });

  it('rejects overlap >= maxTokens', () => {
    expect(() => chunkText('x', { maxTokens: 10, overlapTokens: 10 })).toThrow(/overlap/);
  });
});
