import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServerDeps } from '../deps.js';
import { toolFailure } from './helpers.js';

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

const inputSchema = z.object({
  run_id: z.string().describe('Run id returned by run_actor or scrape_url'),
});

const outputSchema = z.object({
  run_id: z.string(),
  status: z.string(),
  finished: z.boolean(),
  dataset_id: z.string().nullable(),
  status_message: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

export function registerGetRunStatus(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_run_status',
    {
      title: 'Get actor run status',
      description:
        'Check whether an actor run has finished and where its dataset is. ' +
        'Free and safe to poll.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ run_id }) => {
      try {
        const run = await deps.gateway.getRun(run_id);
        if (!run) {
          return toolFailure(new Error(`Run ${run_id} not found.`));
        }
        const finished = TERMINAL_STATUSES.has(run.status);
        const structured = {
          run_id: run.runId,
          status: run.status,
          finished,
          dataset_id: run.datasetId,
          status_message: run.statusMessage,
          started_at: run.startedAt,
          finished_at: run.finishedAt,
        };
        const hint = finished
          ? run.status === 'SUCCEEDED'
            ? `Fetch results with fetch_dataset_items using dataset_id ${run.datasetId}.`
            : 'The run did not succeed; inspect status_message before retrying.'
          : 'Still running — poll again shortly.';
        return {
          content: [{ type: 'text', text: `Run ${run.runId}: ${run.status}. ${hint}` }],
          structuredContent: structured,
        };
      } catch (err) {
        return toolFailure(err);
      }
    },
  );
}
