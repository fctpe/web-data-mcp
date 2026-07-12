import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { escalateInput, MAX_QUALITY_ATTEMPTS } from '../core/escalation.js';
import { assertAllowedActor } from '../core/guards.js';
import { assessQuality, type QualityReport } from '../core/quality.js';
import type { ServerDeps } from '../deps.js';
import { qualityOutput, qualityToWire, toolFailure } from './helpers.js';

const SAMPLE_SIZE = 200;

const inputSchema = z.object({
  run_id: z.string().describe('Run whose output quality was too low'),
  json_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('JSON Schema items should satisfy; also drives the quality score'),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe('Stop retrying once the quality score reaches this value'),
  max_attempts: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUALITY_ATTEMPTS - 1)
    .default(2)
    .describe('Maximum number of re-runs (each escalates proxy/browser settings)'),
});

const outputSchema = z.object({
  final_run_id: z.string(),
  final_dataset_id: z.string().nullable(),
  attempts: z.number().int(),
  reached_threshold: z.boolean(),
  initial_quality: qualityOutput,
  final_quality: qualityOutput,
});

export function registerRetryLowQualityRun(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'retry_low_quality_run',
    {
      title: 'Retry a low-quality run',
      description:
        'Re-run an actor with progressively stronger anti-blocking settings (residential ' +
        'proxies, then a browser crawler) until the dataset quality score reaches the ' +
        'threshold or attempts are exhausted. Each attempt costs Apify credits.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ run_id, json_schema, threshold, max_attempts }) => {
      try {
        const { gateway, config } = deps;
        const originalRun = await gateway.getRun(run_id);
        if (!originalRun) {
          return toolFailure(new Error(`Run ${run_id} not found.`));
        }
        assertAllowedActor(originalRun.actorId, config.allowedActors);

        const originalInput = await gateway.getRunInput(run_id);
        if (!originalInput) {
          return toolFailure(
            new Error(`Could not read the original input of run ${run_id}; cannot re-run it.`),
          );
        }

        const schemaOpt = json_schema !== undefined ? { schema: json_schema } : {};
        const scoreDataset = async (datasetId: string | null): Promise<QualityReport> => {
          if (!datasetId) return assessQuality([], schemaOpt);
          const page = await gateway.listDatasetItems(datasetId, { limit: SAMPLE_SIZE });
          return assessQuality(page.items, schemaOpt);
        };

        const initialQuality = await scoreDataset(originalRun.datasetId);
        let bestRun = originalRun;
        let bestQuality = initialQuality;
        let attempts = 0;

        const attemptFailures: string[] = [];
        while (bestQuality.score < threshold && attempts < max_attempts) {
          attempts++;
          const input = escalateInput(originalInput, attempts + 1);
          let rerun: Awaited<ReturnType<typeof gateway.callActor>>;
          try {
            rerun = await gateway.callActor(originalRun.actorId, input, {
              waitSecs: config.limits.maxWaitSecs,
            });
          } catch (err) {
            // A failed escalation (e.g. no residential proxy access) must not
            // destroy the best-run-so-far report this tool exists to provide.
            attemptFailures.push(err instanceof Error ? err.message : String(err));
            continue;
          }
          if (rerun.status !== 'SUCCEEDED') {
            attemptFailures.push(`run ${rerun.runId} finished ${rerun.status}`);
            continue;
          }
          const quality = await scoreDataset(rerun.datasetId);
          if (quality.score > bestQuality.score) {
            bestRun = rerun;
            bestQuality = quality;
          }
        }

        const reached = bestQuality.score >= threshold;
        const structured = {
          final_run_id: bestRun.runId,
          final_dataset_id: bestRun.datasetId,
          attempts,
          reached_threshold: reached,
          initial_quality: qualityToWire(initialQuality),
          final_quality: qualityToWire(bestQuality),
        };

        if (!reached && attempts >= max_attempts) {
          const failureNote =
            attemptFailures.length > 0 ? ` Failed attempts: ${attemptFailures.join('; ')}.` : '';
          return {
            content: [
              {
                type: 'text',
                text:
                  `Quality is still ${bestQuality.score} (< ${threshold}) after ${attempts} ` +
                  `escalated re-run(s). Best dataset so far: ${bestRun.datasetId}. The target ` +
                  'site is likely blocking hard or the schema does not match its output — ' +
                  `inspect sample_failures and adjust the schema or accept the best result.${failureNote}`,
              },
            ],
            structuredContent: structured,
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text:
                `Quality improved from ${initialQuality.score} to ${bestQuality.score} in ` +
                `${attempts} re-run(s). Use dataset_id ${bestRun.datasetId}.`,
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
