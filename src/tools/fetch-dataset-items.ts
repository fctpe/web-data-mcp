import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clamp } from '../core/guards.js';
import type { ServerDeps } from '../deps.js';
import { fitToTokenBudget, toolFailure } from './helpers.js';

const inputSchema = z.object({
  dataset_id: z.string().describe('Dataset id from run_actor / scrape_url / get_run_status'),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(50),
  fields: z
    .array(z.string())
    .optional()
    .describe('Project only these top-level fields (cuts token cost drastically)'),
  response_format: z
    .enum(['summary', 'items'])
    .default('summary')
    .describe('"summary" describes the data cheaply; "items" returns raw JSON items'),
  max_tokens: z.number().int().min(500).max(25_000).default(10_000),
});

const outputSchema = z.object({
  dataset_id: z.string(),
  total: z.number().int(),
  offset: z.number().int(),
  returned: z.number().int(),
  next_offset: z.number().int().nullable(),
  truncated: z.boolean(),
  fields_seen: z.array(z.object({ field: z.string(), fill_rate: z.number() })),
});

function summarizeFields(items: unknown[]): { field: string; fill_rate: number }[] {
  const records = items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
  if (records.length === 0) return [];
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (value !== null && value !== undefined && value !== '') {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      } else {
        counts.set(key, counts.get(key) ?? 0);
      }
    }
  }
  return [...counts.entries()]
    .map(([field, filled]) => ({
      field,
      fill_rate: Math.round((filled / records.length) * 100) / 100,
    }))
    .sort((a, b) => b.fill_rate - a.fill_rate);
}

export function registerFetchDatasetItems(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'fetch_dataset_items',
    {
      title: 'Fetch dataset items',
      description:
        'Read items from an actor run dataset with pagination, field projection, and a hard ' +
        'token budget. Start with response_format "summary" to see the shape cheaply, then ' +
        'fetch "items" with a fields projection.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ dataset_id, offset, limit, fields, response_format, max_tokens }) => {
      try {
        const { gateway, config } = deps;
        const page = await gateway.listDatasetItems(dataset_id, {
          offset,
          limit: clamp(limit, 1, config.limits.maxItemsPerPage),
          ...(fields !== undefined && { fields }),
        });

        const fieldsSeen = summarizeFields(page.items);

        if (response_format === 'summary') {
          const preview = page.items[0] ? JSON.stringify(page.items[0]).slice(0, 1500) : 'n/a';
          const structured = {
            dataset_id,
            total: page.total,
            offset: page.offset,
            returned: 0,
            next_offset: page.offset + page.count < page.total ? page.offset + page.count : null,
            truncated: false,
            fields_seen: fieldsSeen,
          };
          const fieldLines = fieldsSeen
            .map((entry) => `- ${entry.field}: ${Math.round(entry.fill_rate * 100)}% filled`)
            .join('\n');
          return {
            content: [
              {
                type: 'text',
                text:
                  `Dataset ${dataset_id}: ${page.total} items total.\n\nFields:\n${fieldLines}\n\n` +
                  `First item preview:\n${preview}\n\n` +
                  'Call again with response_format "items" and a fields projection to read data.',
              },
            ],
            structuredContent: structured,
          };
        }

        const fit = fitToTokenBudget(page.items, max_tokens);
        const included = fit.serialized;
        const nextOffset =
          page.offset + fit.includedCount < page.total ? page.offset + fit.includedCount : null;
        const structured = {
          dataset_id,
          total: page.total,
          offset: page.offset,
          returned: fit.includedCount,
          next_offset: nextOffset,
          truncated: fit.truncated,
          fields_seen: fieldsSeen,
        };
        const note = fit.truncated
          ? `\n\n(Token budget hit: returned ${fit.includedCount} of ${page.count} fetched items. Continue at offset ${nextOffset}.)`
          : '';
        return {
          content: [{ type: 'text', text: `[${included.join(',\n')}]${note}` }],
          structuredContent: structured,
        };
      } catch (err) {
        return toolFailure(err);
      }
    },
  );
}
