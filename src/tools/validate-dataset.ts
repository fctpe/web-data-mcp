import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clamp } from '../core/guards.js';
import { assessQuality } from '../core/quality.js';
import type { ServerDeps } from '../deps.js';
import { qualityOutput, qualityToWire, toolFailure } from './helpers.js';

const inputSchema = z.object({
  dataset_id: z.string(),
  json_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('JSON Schema each item should satisfy; omit for schema-free quality metrics'),
  sample_size: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .describe('How many items to inspect (from the start of the dataset)'),
});

const outputSchema = z.object({
  dataset_id: z.string(),
  sampled: z.number().int(),
  total: z.number().int(),
  quality: qualityOutput,
});

export function registerValidateDataset(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'validate_dataset',
    {
      title: 'Validate dataset quality',
      description:
        'Score a dataset before trusting it: schema pass rate (if a JSON Schema is given), ' +
        'field completeness, duplicate rate, and bot-wall detection. Use the score to decide ' +
        'between consuming the data and retry_low_quality_run.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ dataset_id, json_schema, sample_size }) => {
      try {
        const { gateway, config } = deps;
        const page = await gateway.listDatasetItems(dataset_id, {
          limit: clamp(sample_size, 1, config.limits.maxValidationSample),
        });
        const quality = assessQuality(page.items, {
          ...(json_schema !== undefined && { schema: json_schema }),
        });
        const structured = {
          dataset_id,
          sampled: page.count,
          total: page.total,
          quality: qualityToWire(quality),
        };
        const verdict =
          quality.score >= 0.8
            ? 'Good — safe to consume.'
            : quality.score >= 0.5
              ? 'Mixed — inspect sample_failures before consuming.'
              : 'Poor — consider retry_low_quality_run.';
        const failures =
          quality.sampleFailures.length > 0
            ? `\nSample failures:\n${quality.sampleFailures.map((failure) => `- ${failure}`).join('\n')}`
            : '';
        return {
          content: [
            {
              type: 'text',
              text:
                `Quality score ${quality.score} over ${page.count}/${page.total} items. ${verdict}` +
                failures,
            },
          ],
          structuredContent: structured,
        };
      } catch (err) {
        return toolFailure(err);
      }
    },
  );
}
