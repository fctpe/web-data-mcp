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

  it('falls back to the longest string field when no conventional content field exists', () => {
    const instructions =
      'Den Teig aus Mehl, Butter und Zucker kneten, die Äpfel schälen und in Spalten schneiden, ' +
      'alles in eine Springform geben und bei 180 Grad etwa 45 Minuten backen.';
    const { documents, skippedItems } = itemsToRagDocuments(
      [{ recipeId: 'r1', title: 'Apfelkuchen', url: 'https://example.com/r1', instructions }],
      { maxTokens: 512, overlapTokens: 0 },
    );
    expect(skippedItems).toBe(0);
    expect(documents[0]?.content).toBe(instructions);
    expect(documents[0]?.source).toBe('https://example.com/r1');
  });

  it('does not treat short id/title strings as document content', () => {
    const { documents, skippedItems } = itemsToRagDocuments(
      [{ recipeId: 'r1', title: 'Apfelkuchen', category: 'Backen' }],
      { maxTokens: 512, overlapTokens: 0 },
    );
    expect(documents).toHaveLength(0);
    expect(skippedItems).toBe(1);
  });

  it('never mistakes a long URL for document content (live-ads regression)', () => {
    const cdnUrl = `https://scontent.example-cdn.net/v/t39.35426-6/img.jpg?${'x'.repeat(300)}`;
    const adCopy =
      'The best style lives on our marketplace. Shop curated fashion from real people, ' +
      'sell what you no longer wear, and give every piece a second life.';
    const { documents } = itemsToRagDocuments(
      [{ pageProfilePictureUrl: cdnUrl, adCopy, adArchiveId: 'a1' }],
      { maxTokens: 512, overlapTokens: 0 },
    );
    expect(documents).toHaveLength(1);
    expect(documents[0]?.content).toBe(adCopy);
  });

  it('skips items whose only long string is a URL rather than embedding it', () => {
    const cdnUrl = `https://cdn.example.net/asset?${'y'.repeat(300)}`;
    const { documents, skippedItems } = itemsToRagDocuments([{ imageUrl: cdnUrl, id: '1' }], {
      maxTokens: 512,
      overlapTokens: 0,
    });
    expect(documents).toHaveLength(0);
    expect(skippedItems).toBe(1);
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

describe('document ids carry source identity', () => {
  // Boilerplate is byte-identical across a crawl. Under the old
  // `sha256(content)` id these two rows were one document, and a vector store
  // upserting by id kept whichever landed last — silently attributing one
  // site's page to the other.
  const BOILERPLATE = 'This item is currently unavailable. Check back soon or browse similar.';

  it('gives identical text from two different sources different ids', () => {
    const { documents } = itemsToRagDocuments(
      [
        { url: 'https://shop-a.example/p/1', text: BOILERPLATE },
        { url: 'https://shop-b.example/p/9', text: BOILERPLATE },
      ],
      { maxTokens: 512, overlapTokens: 0 },
    );

    // Negative control. The whole test rests on these two documents actually
    // being the collision case: same bytes, different origin. If a later edit
    // makes the fixtures differ, the id assertion below would pass for a reason
    // that has nothing to do with source identity — which is how a green test
    // stops proving anything.
    expect(documents).toHaveLength(2);
    expect(documents[0]?.content).toBe(documents[1]?.content);
    expect(documents[0]?.source).not.toBe(documents[1]?.source);

    expect(documents[0]?.id).not.toBe(documents[1]?.id);
  });

  it('keeps the same source and text on the same id, so upserts stay idempotent', () => {
    const item = { url: 'https://shop-a.example/p/1', text: BOILERPLATE };
    const first = itemsToRagDocuments([item], { maxTokens: 512, overlapTokens: 0 });
    const second = itemsToRagDocuments([item], { maxTokens: 512, overlapTokens: 0 });
    expect(first.documents[0]?.id).toBe(second.documents[0]?.id);
  });

  it('collapses sourceless items with identical content, deliberately', () => {
    const { documents } = itemsToRagDocuments([{ text: BOILERPLATE }, { text: BOILERPLATE }], {
      maxTokens: 512,
      overlapTokens: 0,
    });
    expect(documents[0]?.source).toBeNull();
    expect(documents[0]?.id).toBe(documents[1]?.id);
  });

  it('does not let a source/content boundary be forged', () => {
    // `sourceKey + ' ' + content` with a raw url as sourceKey would make these
    // two hash the same. The source is hashed to fixed width first, so it
    // cannot be spelled out inside someone else's content.
    const withSource = itemsToRagDocuments(
      [{ url: 'https://shop-a.example', text: 'trailing body' }],
      { maxTokens: 512, overlapTokens: 0 },
    );
    const forged = itemsToRagDocuments([{ text: 'https://shop-a.example trailing body' }], {
      maxTokens: 512,
      overlapTokens: 0,
    });
    expect(withSource.documents[0]?.id).not.toBe(forged.documents[0]?.id);
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
