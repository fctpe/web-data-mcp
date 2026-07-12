import { createHash } from 'node:crypto';
import { chunkText } from './chunker.js';

export interface RagDocument {
  id: string;
  /** Position of the originating item within the fetched page — lets callers
   *  paginate by whole items when a response budget truncates the output. */
  itemIndex: number;
  source: string | null;
  chunkIndex: number;
  chunkCount: number;
  tokenCount: number;
  content: string;
  metadata: Record<string, unknown>;
}

const CONTENT_FIELD_PRIORITY = ['markdown', 'text', 'content', 'body', 'description'];
const SOURCE_FIELD_PRIORITY = ['url', 'link', 'sourceUrl', 'source_url', 'loadedUrl'];
/* Fallback floor: shorter strings (ids, titles, enum values) are not document text. */
const MIN_FALLBACK_CONTENT_CHARS = 80;
/* Prose has whitespace between words; URLs, tokens, and base64 blobs do not.
   Without this, a long CDN URL out-lengths the actual ad copy and the
   "document" becomes an image URL (found by live testing against real ads). */
const URL_LIKE = /^(https?:\/\/|www\.|data:)/i;
const MIN_SPACE_RATIO = 0.05;

function looksLikeProse(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_FALLBACK_CONTENT_CHARS) return false;
  if (URL_LIKE.test(trimmed)) return false;
  const spaces = (trimmed.match(/\s/g) ?? []).length;
  return spaces / trimmed.length >= MIN_SPACE_RATIO;
}

function longestProseField(item: Record<string, unknown>): string | null {
  let best: string | null = null;
  for (const value of Object.values(item)) {
    if (typeof value === 'string' && looksLikeProse(value) && value.length > (best?.length ?? 0)) {
      best = value;
    }
  }
  return best;
}

function pickContent(item: Record<string, unknown>, contentFields?: string[]): string | null {
  if (contentFields && contentFields.length > 0) {
    const parts = contentFields
      .map((field) => item[field])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  for (const field of CONTENT_FIELD_PRIORITY) {
    const value = item[field];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return longestProseField(item);
}

function pickSource(item: Record<string, unknown>): string | null {
  for (const field of SOURCE_FIELD_PRIORITY) {
    const value = item[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Converts raw dataset items into embedding-ready documents: one stable-id
 * chunk per document, with source attribution and selected metadata carried
 * through. The content hash makes downstream vector upserts idempotent.
 */
export function itemsToRagDocuments(
  items: unknown[],
  opts: {
    contentFields?: string[];
    metadataFields?: string[];
    maxTokens: number;
    overlapTokens: number;
  },
): { documents: RagDocument[]; skippedItems: number } {
  const documents: RagDocument[] = [];
  let skippedItems = 0;

  for (const [itemIndex, raw] of items.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      skippedItems++;
      continue;
    }
    const item = raw as Record<string, unknown>;
    const content = pickContent(item, opts.contentFields);
    if (!content) {
      skippedItems++;
      continue;
    }

    const source = pickSource(item);
    const metadata: Record<string, unknown> = {};
    for (const field of opts.metadataFields ?? []) {
      if (field in item) metadata[field] = item[field];
    }

    const chunks = chunkText(content, {
      maxTokens: opts.maxTokens,
      overlapTokens: opts.overlapTokens,
    });
    const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

    for (const chunk of chunks) {
      documents.push({
        id: `${contentHash}-${chunk.index}`,
        itemIndex,
        source,
        chunkIndex: chunk.index,
        chunkCount: chunks.length,
        tokenCount: chunk.tokenCount,
        content: chunk.content,
        metadata,
      });
    }
  }

  return { documents, skippedItems };
}

export type DocumentFormat = 'json' | 'markdown' | 'text';

export function renderDocuments(documents: RagDocument[], format: DocumentFormat): string {
  switch (format) {
    case 'json':
      return documents.map((doc) => JSON.stringify(doc)).join('\n');
    case 'markdown':
      return documents
        .map((doc) => {
          const header = doc.source
            ? `### ${doc.source} (chunk ${doc.chunkIndex + 1}/${doc.chunkCount})`
            : `### chunk ${doc.chunkIndex + 1}/${doc.chunkCount}`;
          return `${header}\n\n${doc.content}`;
        })
        .join('\n\n---\n\n');
    case 'text':
      return documents.map((doc) => doc.content).join('\n\n');
  }
}
