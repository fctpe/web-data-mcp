import * as z from 'zod/v4';
import type { QualityReport } from '../core/quality.js';
import { countTokens } from '../core/tokens.js';

export const qualityOutput = z.object({
  score: z.number().describe('Composite 0..1 quality score'),
  item_count: z.number().int(),
  schema_pass_rate: z.number().nullable(),
  field_completeness: z.number(),
  duplicate_rate: z.number(),
  suspected_block_rate: z.number().describe('Fraction of items containing bot-wall markers'),
  sample_failures: z.array(z.string()),
});

export type QualityWire = z.infer<typeof qualityOutput>;

export function qualityToWire(report: QualityReport): QualityWire {
  return {
    score: report.score,
    item_count: report.itemCount,
    schema_pass_rate: report.schemaPassRate,
    field_completeness: report.fieldCompleteness,
    duplicate_rate: report.duplicateRate,
    suspected_block_rate: report.suspectedBlockRate,
    sample_failures: report.sampleFailures,
  };
}

export type ToolFailure = {
  content: { type: 'text'; text: string }[];
  isError: true;
};

export function toolFailure(err: unknown): ToolFailure {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Serializes items into the response until the token budget is spent.
 * Returns the JSON strings that fit plus how many items were left out.
 */
export function fitToTokenBudget(
  items: unknown[],
  maxTokens: number,
): { serialized: string[]; includedCount: number; truncated: boolean } {
  const serialized: string[] = [];
  let spent = 0;
  for (const item of items) {
    const json = JSON.stringify(item);
    const cost = countTokens(json);
    if (spent + cost > maxTokens && serialized.length > 0) {
      return { serialized, includedCount: serialized.length, truncated: true };
    }
    if (spent + cost > maxTokens) {
      return { serialized, includedCount: 0, truncated: true };
    }
    serialized.push(json);
    spent += cost;
  }
  return { serialized, includedCount: serialized.length, truncated: false };
}
