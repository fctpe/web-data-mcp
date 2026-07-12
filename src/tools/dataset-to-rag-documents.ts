import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clamp } from '../core/guards.js';
import { type DocumentFormat, itemsToRagDocuments, renderDocuments } from '../core/rag.js';
import type { ServerDeps } from '../deps.js';
import { paginationInfo, toolFailure } from './helpers.js';

const inputSchema = z.object({
  dataset_id: z.string(),
  content_fields: z
    .array(z.string())
    .optional()
    .describe(
      'Item fields to use as document text; auto-detects markdown/text/content when omitted',
    ),
  metadata_fields: z
    .array(z.string())
    .optional()
    .describe('Item fields to carry into each document’s metadata'),
  max_tokens_per_chunk: z.number().int().min(64).max(4096).default(512),
  overlap_tokens: z.number().int().min(0).max(512).default(64),
  format: z
    .enum(['json', 'markdown', 'text'])
    .default('json')
    .describe('"json" emits one JSON document per line (jsonl), ready for embedding pipelines'),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(50),
  max_response_tokens: z.number().int().min(1000).max(25_000).default(15_000),
});

const outputSchema = z.object({
  dataset_id: z.string(),
  documents: z.number().int(),
  skipped_items: z.number().int(),
  total_tokens: z.number().int(),
  next_offset: z.number().int().nullable(),
  truncated: z.boolean(),
});

export function registerDatasetToRagDocuments(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'dataset_to_rag_documents',
    {
      title: 'Convert dataset to RAG documents',
      description:
        'Turn scraped items into embedding-ready documents: token-bounded chunks with overlap, ' +
        'source attribution, stable content-hash ids for idempotent vector upserts, and ' +
        'selected metadata. Paginate with offset/limit for large datasets.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({
      dataset_id,
      content_fields,
      metadata_fields,
      max_tokens_per_chunk,
      overlap_tokens,
      format,
      offset,
      limit,
      max_response_tokens,
    }) => {
      try {
        const { gateway, config } = deps;
        if (overlap_tokens >= max_tokens_per_chunk) {
          return toolFailure(
            new Error('overlap_tokens must be smaller than max_tokens_per_chunk.'),
          );
        }
        const pageLimit = clamp(limit, 1, config.limits.maxItemsPerPage);
        const page = await gateway.listDatasetItems(dataset_id, { offset, limit: pageLimit });

        const { documents, skippedItems } = itemsToRagDocuments(page.items, {
          ...(content_fields !== undefined && { contentFields: content_fields }),
          ...(metadata_fields !== undefined && { metadataFields: metadata_fields }),
          maxTokens: max_tokens_per_chunk,
          overlapTokens: overlap_tokens,
        });

        const kept: typeof documents = [];
        let spent = 0;
        let truncated = false;
        for (const doc of documents) {
          const cost = doc.tokenCount + 40;
          if (spent + cost > max_response_tokens) {
            truncated = true;
            break;
          }
          kept.push(doc);
          spent += cost;
        }

        const rendered = renderDocuments(kept, format as DocumentFormat);
        const totalTokens = kept.reduce((sum, doc) => sum + doc.tokenCount, 0);
        const { nextOffset } = paginationInfo(page, pageLimit);
        const structured = {
          dataset_id,
          documents: kept.length,
          skipped_items: skippedItems,
          total_tokens: totalTokens,
          next_offset: nextOffset,
          truncated,
        };
        const note = [
          `${kept.length} document(s), ${totalTokens} content tokens`,
          skippedItems > 0 ? `${skippedItems} item(s) skipped (no usable text field)` : null,
          truncated ? 'response token budget hit — paginate or narrow content_fields' : null,
          nextOffset !== null ? `continue at offset ${nextOffset}` : null,
        ]
          .filter(Boolean)
          .join('; ');

        return {
          content: [{ type: 'text', text: `${note}\n\n${rendered}` }],
          structuredContent: structured,
        };
      } catch (err) {
        return toolFailure(err);
      }
    },
  );
}
