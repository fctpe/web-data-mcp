import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { WebDataError } from './errors.js';

export interface QualityReport {
  score: number;
  itemCount: number;
  schemaPassRate: number | null;
  fieldCompleteness: number;
  duplicateRate: number;
  suspectedBlockRate: number;
  sampleFailures: string[];
}

const BLOCK_MARKERS =
  /access denied|captcha|verify you are human|enable javascript|are you a robot|unusual traffic|attention required/i;

const MAX_SAMPLE_FAILURES = 5;

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function looksBlocked(item: Record<string, unknown>): boolean {
  return Object.values(item).some(
    (value) => typeof value === 'string' && BLOCK_MARKERS.test(value.slice(0, 2000)),
  );
}

function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  const ajv = new Ajv({ allErrors: false, strict: false });
  try {
    return ajv.compile(schema);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WebDataError(`Invalid JSON Schema: ${detail}`);
  }
}

/**
 * Scores a batch of scraped items on schema conformance, field completeness,
 * duplication, and bot-wall markers. Score is 0..1; an empty batch scores 0.
 */
export function assessQuality(
  items: unknown[],
  opts: { schema?: Record<string, unknown> } = {},
): QualityReport {
  const records = items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );

  if (records.length === 0) {
    return {
      score: 0,
      itemCount: 0,
      schemaPassRate: opts.schema ? 0 : null,
      fieldCompleteness: 0,
      duplicateRate: 0,
      suspectedBlockRate: 0,
      sampleFailures:
        items.length === 0 ? ['Dataset is empty.'] : ['No object-shaped items found.'],
    };
  }

  const allKeys = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) allKeys.add(key);
  }

  let filledCells = 0;
  for (const record of records) {
    for (const key of allKeys) {
      if (!isEmptyValue(record[key])) filledCells++;
    }
  }
  const fieldCompleteness = allKeys.size === 0 ? 0 : filledCells / (records.length * allKeys.size);

  const seen = new Set<string>();
  let duplicates = 0;
  for (const record of records) {
    const hash = createHash('sha1').update(JSON.stringify(record)).digest('hex');
    if (seen.has(hash)) duplicates++;
    else seen.add(hash);
  }
  const duplicateRate = duplicates / records.length;

  const blocked = records.filter(looksBlocked).length;
  const suspectedBlockRate = blocked / records.length;

  let schemaPassRate: number | null = null;
  const sampleFailures: string[] = [];
  if (opts.schema) {
    const validate = compileSchema(opts.schema);
    let passed = 0;
    for (const [index, record] of records.entries()) {
      if (validate(record)) {
        passed++;
      } else if (sampleFailures.length < MAX_SAMPLE_FAILURES) {
        const first = validate.errors?.[0];
        sampleFailures.push(
          `item[${index}]${first?.instancePath ?? ''}: ${first?.message ?? 'schema violation'}`,
        );
      }
    }
    schemaPassRate = passed / records.length;
  }

  const weighted =
    schemaPassRate === null
      ? 0.5 * fieldCompleteness + 0.25 * (1 - duplicateRate) + 0.25 * (1 - suspectedBlockRate)
      : 0.4 * schemaPassRate +
        0.3 * fieldCompleteness +
        0.15 * (1 - duplicateRate) +
        0.15 * (1 - suspectedBlockRate);

  // A bot wall is not a low-quality page, it is an absent one — so blocking is
  // a ceiling on the score, not a 0.15 deduction from it.
  //
  // As a weighted term alone it could never trigger a retry. A batch of pages
  // that are 100% bot walls but carry a url and >50 chars of "Attention
  // Required! | Cloudflare…" scores 0.4 schema + 0.3 completeness + 0.15
  // non-duplicate + 0 blocked = 0.85, sailing past the 0.70 retry threshold in
  // scrape-url. The escalation ladder — residential proxies, then a real
  // browser — existed for exactly that page and never ran for it.
  //
  // The ceiling is `1 - suspectedBlockRate`, which reads as: a batch cannot
  // score above the fraction of it that is actually content. All blocked caps
  // at 0; a quarter blocked caps at 0.75. Nothing changes for a clean batch,
  // where the ceiling is 1.
  const score = Math.min(weighted, 1 - suspectedBlockRate);

  return {
    score: Math.round(score * 1000) / 1000,
    itemCount: records.length,
    schemaPassRate,
    fieldCompleteness: Math.round(fieldCompleteness * 1000) / 1000,
    duplicateRate: Math.round(duplicateRate * 1000) / 1000,
    suspectedBlockRate: Math.round(suspectedBlockRate * 1000) / 1000,
    sampleFailures,
  };
}
