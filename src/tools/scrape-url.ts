import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { escalateInput, MAX_QUALITY_ATTEMPTS } from '../core/escalation.js';
import { assertAllowedActor, assertSafeUrl, clamp } from '../core/guards.js';
import { assessQuality } from '../core/quality.js';
import { countTokens, truncateToTokens } from '../core/tokens.js';
import type { ServerDeps } from '../deps.js';
import { qualityOutput, qualityToWire, toolFailure } from './helpers.js';

const SCRAPER_ACTOR = 'apify/website-content-crawler';
const QUALITY_THRESHOLD = 0.7;
const SAMPLE_SIZE = 50;

/**
 * Escalate whenever more than a fifth of the sample looks like a bot wall, even
 * if the composite score is otherwise fine.
 *
 * `assessQuality` already caps the score at `1 - suspectedBlockRate`, which
 * catches a wholly blocked batch. A partly blocked one is the case the cap
 * alone still lets through: 25% walls caps at 0.75, above the 0.70 threshold,
 * and a quarter of the pages being walls is precisely the signal a residential
 * proxy is meant to answer. Blocking is a distinct failure with a distinct
 * remedy, so it gets its own trigger rather than being folded into a number
 * that mixes it with schema drift and duplicates.
 */
const BLOCK_RATE_THRESHOLD = 0.2;

/** Both reasons a run is worth escalating, in one place so the retry loop and
 * the caller-facing summary can never disagree about what "good enough" means. */
function needsEscalation(quality: { score: number; suspectedBlockRate: number }): boolean {
  return quality.score < QUALITY_THRESHOLD || quality.suspectedBlockRate > BLOCK_RATE_THRESHOLD;
}

/** Minimum shape a usable page item must have: a URL plus non-empty text or markdown. */
const PAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['url'],
  properties: { url: { type: 'string' } },
  anyOf: [
    { required: ['text'], properties: { text: { type: 'string', minLength: 50 } } },
    { required: ['markdown'], properties: { markdown: { type: 'string', minLength: 50 } } },
  ],
};

const inputSchema = z.object({
  url: z.string().describe('Public http(s) URL to scrape'),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(1)
    .describe('How many pages to crawl starting from the URL (same site)'),
  max_tokens: z
    .number()
    .int()
    .min(500)
    .max(25_000)
    .default(8000)
    .describe('Token budget for the returned page content'),
  quality_retry: z
    .boolean()
    .default(true)
    .describe('Re-run with residential proxies / a browser crawler when quality is low'),
});

const outputSchema = z.object({
  run_id: z.string(),
  dataset_id: z.string().nullable(),
  attempts: z.number().int(),
  quality: qualityOutput,
  pages: z.array(z.object({ url: z.string(), tokens: z.number().int() })),
  truncated: z.boolean(),
});

export function registerScrapeUrl(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'scrape_url',
    {
      title: 'Scrape a URL (quality-gated)',
      description:
        'Scrape a public web page into clean markdown in one call: runs a crawler, waits, ' +
        'scores the result (completeness, bot-wall detection), and automatically retries ' +
        'with stronger settings when quality is low. Costs Apify credits per run. ' +
        'For arbitrary actors or fire-and-forget runs use run_actor instead.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ url, max_pages, max_tokens, quality_retry }) => {
      try {
        assertSafeUrl(url);
        const { gateway, config } = deps;
        // The built-in crawler is still subject to the operator's allowlist.
        assertAllowedActor(SCRAPER_ACTOR, config.allowedActors);
        const baseInput: Record<string, unknown> = {
          startUrls: [{ url }],
          maxCrawlPages: max_pages,
          maxCrawlDepth: max_pages > 1 ? 1 : 0,
          crawlerType: 'cheerio',
          saveMarkdown: true,
        };

        const maxAttempts = quality_retry ? MAX_QUALITY_ATTEMPTS : 1;
        let attempt = 0;
        // Track the best successful attempt: a failed escalation must never
        // discard an earlier run that already produced usable (if imperfect)
        // content the caller paid for.
        let bestRun = null;
        let bestItems: unknown[] = [];
        let bestQuality = assessQuality([], { schema: PAGE_SCHEMA });
        let lastFailure: string | null = null;

        while (attempt < maxAttempts) {
          attempt++;
          let run: Awaited<ReturnType<typeof gateway.callActor>>;
          try {
            run = await gateway.callActor(SCRAPER_ACTOR, escalateInput(baseInput, attempt), {
              memoryMb: clamp(4096, 128, config.limits.maxMemoryMb),
              timeoutSecs: clamp(300, 30, config.limits.maxTimeoutSecs),
              waitSecs: config.limits.maxWaitSecs,
            });
          } catch (err) {
            lastFailure = err instanceof Error ? err.message : String(err);
            continue;
          }
          if (run.status !== 'SUCCEEDED' || !run.datasetId) {
            lastFailure =
              `run ${run.runId} finished with status ${run.status}` +
              `${run.statusMessage ? ` (${run.statusMessage})` : ''}`;
            continue;
          }
          const page = await gateway.listDatasetItems(run.datasetId, { limit: SAMPLE_SIZE });
          const quality = assessQuality(page.items, { schema: PAGE_SCHEMA });
          if (!bestRun || quality.score > bestQuality.score) {
            bestRun = run;
            bestItems = page.items;
            bestQuality = quality;
          }
          if (!needsEscalation(quality)) break;
        }

        if (!bestRun) {
          return toolFailure(
            new Error(
              `Scrape failed after ${attempt} attempt(s): ${lastFailure ?? 'no successful run'}. ` +
                'Check get_run_status on any reported run id or retry later.',
            ),
          );
        }
        const run = bestRun;
        const items = bestItems;
        const quality = bestQuality;

        const records = items.filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        );
        const contentBlocks: string[] = [];
        const pages: { url: string; tokens: number }[] = [];
        for (const record of records) {
          const body =
            typeof record.markdown === 'string' && record.markdown.trim().length > 0
              ? record.markdown
              : typeof record.text === 'string'
                ? record.text
                : '';
          const pageUrl = typeof record.url === 'string' ? record.url : url;
          contentBlocks.push(`## ${pageUrl}\n\n${body}`);
          pages.push({ url: pageUrl, tokens: countTokens(body) });
        }
        const combined = contentBlocks.join('\n\n---\n\n');
        const { text, truncated } = truncateToTokens(combined, max_tokens);

        const structured = {
          run_id: run.runId,
          dataset_id: run.datasetId,
          attempts: attempt,
          quality: qualityToWire(quality),
          pages,
          truncated,
        };

        // Name the bot wall explicitly. "LOW QUALITY" reads as thin content, and
        // a model that is told the content is thin will summarise the wall; one
        // that is told the page was never served will say so instead.
        const blockedNote =
          quality.suspectedBlockRate > BLOCK_RATE_THRESHOLD
            ? ` — BLOCKED: ${Math.round(quality.suspectedBlockRate * 100)}% of sampled pages look` +
              ' like bot walls, not content, and escalation did not get past them'
            : quality.score < QUALITY_THRESHOLD
              ? ' — LOW QUALITY, treat content with caution'
              : '';
        const summaryLine =
          `Scraped ${pages.length} page(s), quality score ${quality.score}` +
          `${attempt > 1 ? ` after ${attempt} attempts` : ''}${blockedNote}.`;

        return {
          content: [{ type: 'text', text: `${summaryLine}\n\n${text}` }],
          structuredContent: structured,
        };
      } catch (err) {
        return toolFailure(err);
      }
    },
  );
}
