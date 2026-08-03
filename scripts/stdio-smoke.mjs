#!/usr/bin/env node
/**
 * Protocol smoke test: does the built server still speak MCP over stdio?
 *
 *   node scripts/stdio-smoke.mjs
 *
 * Spawns dist/index.js as a real subprocess and drives it through a real MCP
 * client, asserting the full tool surface comes back. Needs no Apify token —
 * tools/list never touches the network.
 *
 * This replaces a `npx --yes @modelcontextprotocol/inspector` step in CI. That
 * step resolved the inspector at run time, so an upstream release could (and
 * did) change how it passes environment to the spawned server and turn the
 * build red without a line of this repo changing. Pinning the inspector would
 * fix the immediate breakage; using the client library this repo already
 * depends on removes the external CLI from the critical path entirely.
 *
 * It also guards the thing most likely to break silently: stdout is reserved
 * for the protocol stream, so anything that prints there — a stray log line, a
 * console span exporter — corrupts every message. A round trip proves it clean.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const EXPECTED_TOOLS = [
  'dataset_to_rag_documents',
  'fetch_dataset_items',
  'get_run_status',
  'retry_low_quality_run',
  'run_actor',
  'scrape_url',
  'validate_dataset',
];

const fail = (message) => {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
};

const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });

await client.connect(
  new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { ...process.env, APIFY_TOKEN: process.env.APIFY_TOKEN ?? 'smoke-placeholder' },
  }),
);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();

if (names.length !== EXPECTED_TOOLS.length || names.some((n, i) => n !== EXPECTED_TOOLS[i])) {
  fail(
    `tool surface changed\n  expected: ${EXPECTED_TOOLS.join(', ')}\n  got:      ${names.join(', ')}`,
  );
}

// Every tool ships an output schema; losing one silently downgrades callers to
// unstructured text, which is the whole point of this server.
const missingSchema = tools.filter((t) => !t.outputSchema).map((t) => t.name);
if (missingSchema.length > 0) fail(`tools missing outputSchema: ${missingSchema.join(', ')}`);

// tools/list alone never enters a tool handler, so it would pass even with the
// tracing wrapper thoroughly broken. The SSRF guard rejects this before any
// network call, which makes it a free round trip through the traced path.
const guarded = await client.callTool({
  name: 'scrape_url',
  arguments: { url: 'http://169.254.169.254/latest/meta-data/' },
});
if (!guarded.isError) fail('scrape_url accepted a link-local address');

await client.close();
console.error(`smoke ok — ${names.length} tools, all with output schemas, guard + tool call live`);
