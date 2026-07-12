import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { assertAllowedActor, clamp } from '../core/guards.js';
import type { ServerDeps } from '../deps.js';
import { toolFailure } from './helpers.js';

const inputSchema = z.object({
  actor_id: z.string().describe('Actor to run, e.g. "apify/website-content-crawler"'),
  input: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('Actor input object, passed through as-is'),
  wait_secs: z
    .number()
    .int()
    .min(0)
    .max(300)
    .default(0)
    .describe('0 = return immediately with a run handle; >0 = wait up to this long for completion'),
  memory_mb: z.number().int().min(128).max(8192).optional(),
  timeout_secs: z.number().int().min(10).max(3600).optional(),
});

const outputSchema = z.object({
  run_id: z.string(),
  dataset_id: z.string().nullable(),
  status: z.string(),
  status_message: z.string().nullable(),
});

export function registerRunActor(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'run_actor',
    {
      title: 'Run an Apify actor',
      description:
        'Start an allowlisted Apify actor with an explicit input object. Returns run_id and ' +
        'dataset_id handles for get_run_status / fetch_dataset_items / validate_dataset. ' +
        'Costs Apify credits. Prefer scrape_url for simple page scrapes.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ actor_id, input, wait_secs, memory_mb, timeout_secs }) => {
      try {
        const { gateway, config } = deps;
        assertAllowedActor(actor_id, config.allowedActors);

        const opts = {
          ...(memory_mb !== undefined && {
            memoryMb: clamp(memory_mb, 128, config.limits.maxMemoryMb),
          }),
          ...(timeout_secs !== undefined && {
            timeoutSecs: clamp(timeout_secs, 10, config.limits.maxTimeoutSecs),
          }),
        };

        const run =
          wait_secs > 0
            ? await gateway.callActor(actor_id, input, { ...opts, waitSecs: wait_secs })
            : await gateway.startActor(actor_id, input, opts);

        const structured = {
          run_id: run.runId,
          dataset_id: run.datasetId,
          status: run.status,
          status_message: run.statusMessage,
        };
        const hint =
          run.status === 'SUCCEEDED'
            ? `Fetch results with fetch_dataset_items using dataset_id ${run.datasetId}.`
            : `Poll with get_run_status using run_id ${run.runId}.`;
        return {
          content: [{ type: 'text', text: `Run ${run.runId} is ${run.status}. ${hint}` }],
          structuredContent: structured,
        };
      } catch (err) {
        return toolFailure(err);
      }
    },
  );
}
