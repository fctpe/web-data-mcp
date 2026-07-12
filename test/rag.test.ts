import { describe, expect, it } from 'vitest';
import { itemsToRagDocuments, renderDocuments } from '../src/core/rag.js';

const LONG_TEXT = Array.from(
  { length: 40 },
  (_, index) => `Paragraph ${index} explains one more detail about the product catalog.`,
).join('\n\n');

describe('itemsToRagDocuments', () => {
  it('auto-detects the content field and carries the source URL', () => {
    const { documents, skippedItems } = itemsToRagDocuments(
      [{ url: 'https://example.com/a', text: 'Short but real content about something.' }],
      { maxTokens: 512, overlapTokens: 0 },
    );
    expect(skippedItems).toBe(0);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.source).toBe('https://example.com/a');
    expect(documents[0]?.id).toMatch(/^[0-9a-f]{16}-0$/);
  });

  it('prefers markdown over text in auto-detection', () => {
    const { documents } = itemsToRagDocuments([{ markdown: '# Heading', text: 'plain fallback' }], {
      maxTokens: 512,
      overlapTokens: 0,
    });
    expect(documents[0]?.content).toBe('# Heading');
  });

  it('skips items without usable text and counts them', () => {
    const { documents, skippedItems } = itemsToRagDocuments(
      [{ price: 12 }, null, 'string-item', { text: 'usable content here' }],
      { maxTokens: 512, overlapTokens: 0 },
    );
    expect(documents).toHaveLength(1);
    expect(skippedItems).toBe(3);
  });

  it('chunks long content and numbers the chunks under one content hash', () => {
    const { documents } = itemsToRagDocuments([{ url: 'https://example.com', text: LONG_TEXT }], {
      maxTokens: 100,
      overlapTokens: 10,
    });
    expect(documents.length).toBeGreaterThan(1);
    const prefix = documents[0]?.id.split('-')[0];
    for (const [index, doc] of documents.entries()) {
      expect(doc.id).toBe(`${prefix}-${index}`);
      expect(doc.chunkIndex).toBe(index);
      expect(doc.chunkCount).toBe(documents.length);
    }
  });

  it('copies only the requested metadata fields', () => {
    const { documents } = itemsToRagDocuments(
      [{ text: 'content body', author: 'jane', internal: 'secret', crawledAt: '2026-07-12' }],
      { maxTokens: 512, overlapTokens: 0, metadataFields: ['author', 'crawledAt'] },
    );
    expect(documents[0]?.metadata).toEqual({ author: 'jane', crawledAt: '2026-07-12' });
  });
});

describe('renderDocuments', () => {
  const { documents } = itemsToRagDocuments([{ url: 'https://example.com', text: 'Body text.' }], {
    maxTokens: 512,
    overlapTokens: 0,
  });

  it('renders jsonl', () => {
    const out = renderDocuments(documents, 'json');
    expect(() => JSON.parse(out.split('\n')[0] ?? '')).not.toThrow();
  });

  it('renders markdown with source headers', () => {
    expect(renderDocuments(documents, 'markdown')).toContain('### https://example.com');
  });

  it('renders plain text', () => {
    expect(renderDocuments(documents, 'text')).toBe('Body text.');
  });
});
