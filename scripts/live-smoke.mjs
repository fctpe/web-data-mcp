#!/usr/bin/env node
/**
 * Live smoke test against the real Apify API — run before releases.
 *
 *   APIFY_TOKEN=... SMOKE_ACTOR=apify/hello-world SMOKE_INPUT='{"message":"hi"}' \
 *     node scripts/live-smoke.mjs
 *
 * Drives the built server (dist/index.js) over stdio through a real MCP
 * client: run_actor -> get_run_status -> fetch_dataset_items (summary) ->
 * validate_dataset -> dataset_to_rag_documents. Exits non-zero on failure.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const actor = process.env.SMOKE_ACTOR;
const input = JSON.parse(process.env.SMOKE_INPUT ?? '{}');
if (!process.env.APIFY_TOKEN || !actor) {
  console.error('Set APIFY_TOKEN and SMOKE_ACTOR (and optionally SMOKE_INPUT as JSON).');
  process.exit(2);
}

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};

const client = new Client({ name: 'live-smoke', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { ...process.env, WEB_DATA_MCP_ALLOWED_ACTORS: actor },
  }),
);

const run = await client.callTool({
  name: 'run_actor',
  arguments: { actor_id: actor, input, wait_secs: 300 },
});
if (run.isError) fail(`run_actor: ${run.content?.[0]?.text}`);
const { run_id, dataset_id, status } = run.structuredContent;
console.error(`run ${run_id}: ${status}, dataset ${dataset_id}`);
if (status !== 'SUCCEEDED' || !dataset_id) fail(`run finished ${status}`);

const summary = await client.callTool({
  name: 'fetch_dataset_items',
  arguments: { dataset_id },
});
if (summary.isError) fail(`fetch summary: ${summary.content?.[0]?.text}`);
const total = summary.structuredContent.total;
console.error(`dataset total: ${total}`);
if (total < 1) fail('dataset is empty');

const validated = await client.callTool({
  name: 'validate_dataset',
  arguments: { dataset_id },
});
if (validated.isError) fail(`validate: ${validated.content?.[0]?.text}`);
console.error(`quality score: ${validated.structuredContent.quality.score}`);

const rag = await client.callTool({
  name: 'dataset_to_rag_documents',
  arguments: { dataset_id },
});
if (rag.isError) fail(`rag: ${rag.content?.[0]?.text}`);
console.error(
  `rag documents: ${rag.structuredContent.documents}, skipped: ${rag.structuredContent.skipped_items}`,
);

await client.close();
console.error('SMOKE OK');
