import { createHash } from 'node:crypto';
import { chunkText } from './chunker.js';

export interface RagDocument {
  id: string;
  source: string | null;
  chunkIndex: number;
  chunkCount: number;
  tokenCount: number;
  content: string;
  metadata: Record<string, unknown>;
}

const CONTENT_FIELD_PRIORITY = ['markdown', 'text', 'content', 'body', 'description'];
const SOURCE_FIELD_PRIORITY = ['url', 'link', 'sourceUrl', 'source_url', 'loadedUrl'];

function pickContent(item: Record<string, unknown>, contentFields?: string[]): string | null {
  const fields = contentFields && contentFields.length > 0 ? contentFields : CONTENT_FIELD_PRIORITY;
  const parts = fields
    .map((field) => item[field])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (parts.length === 0) return null;
  return contentFields && contentFields.length > 0 ? parts.join('\n\n') : (parts[0] ?? null);
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

  for (const raw of items) {
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
