import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_ACTORS, DEFAULT_LIMITS } from '../src/config.js';
import { createServer } from '../src/server.js';
import { BLOCKED_PAGE, FakeGateway, GOOD_PAGE, type Scenario } from './fake-gateway.js';

const CONFIG = { allowedActors: DEFAULT_ALLOWED_ACTORS, limits: DEFAULT_LIMITS };

let client: Client | undefined;

async function connect(gateway: FakeGateway): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ gateway, config: CONFIG });
  client = new Client({ name: 'test-harness', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

interface StructuredResult {
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

describe('web-data-mcp server', () => {
  it('lists all seven tools', async () => {
    const mcp = await connect(new FakeGateway(() => ({ items: [] })));
    const { tools } = await mcp.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'dataset_to_rag_documents',
      'fetch_dataset_items',
      'get_run_status',
      'retry_low_quality_run',
      'run_actor',
      'scrape_url',
      'validate_dataset',
    ]);
  });

  it('scrape_url returns page content with a quality block on the happy path', async () => {
    const mcp = await connect(new FakeGateway(() => ({ items: [GOOD_PAGE] })));
    const result = (await mcp.callTool({
      name: 'scrape_url',
      arguments: { url: 'https://example.com/pricing' },
    })) as StructuredResult;
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      attempts: number;
      quality: { score: number };
      pages: unknown[];
    };
    expect(structured.attempts).toBe(1);
    expect(structured.quality.score).toBeGreaterThanOrEqual(0.7);
    expect(structured.pages).toHaveLength(1);
    expect(result.content?.[0]?.text).toContain('Pricing');
  });

  it('scrape_url escalates to residential proxies when the first attempt is blocked', async () => {
    const scenario: Scenario = (_actor, input) => {
      const proxy = input.proxyConfiguration as { apifyProxyGroups?: string[] } | undefined;
      return proxy?.apifyProxyGroups?.includes('RESIDENTIAL')
        ? { items: [GOOD_PAGE] }
        : { items: [BLOCKED_PAGE] };
    };
    const gateway = new FakeGateway(scenario);
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'scrape_url',
      arguments: { url: 'https://example.com/pricing' },
    })) as StructuredResult;
    const structured = result.structuredContent as { attempts: number; quality: { score: number } };
    expect(structured.attempts).toBe(2);
    expect(structured.quality.score).toBeGreaterThanOrEqual(0.7);
    expect(gateway.calls[1]?.input.proxyConfiguration).toMatchObject({
      apifyProxyGroups: ['RESIDENTIAL'],
    });
  });

  it('scrape_url refuses private hosts', async () => {
    const mcp = await connect(new FakeGateway(() => ({ items: [] })));
    const result = (await mcp.callTool({
      name: 'scrape_url',
      arguments: { url: 'http://169.254.169.254/latest/meta-data' },
    })) as StructuredResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('private or local');
  });

  it('run_actor rejects actors outside the allowlist as a tool error', async () => {
    const gateway = new FakeGateway(() => ({ items: [] }));
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'run_actor',
      arguments: { actor_id: 'someone/rogue-actor', input: {} },
    })) as StructuredResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('not on the allowlist');
    expect(gateway.calls).toHaveLength(0);
  });

  it('run_actor + get_run_status round-trip on handles', async () => {
    const gateway = new FakeGateway(() => ({ items: [GOOD_PAGE] }));
    const mcp = await connect(gateway);
    const started = (await mcp.callTool({
      name: 'run_actor',
      arguments: { actor_id: 'apify/cheerio-scraper', input: { startUrls: [] } },
    })) as StructuredResult;
    const runId = (started.structuredContent as { run_id: string }).run_id;
    const status = (await mcp.callTool({
      name: 'get_run_status',
      arguments: { run_id: runId },
    })) as StructuredResult;
    const structured = status.structuredContent as { status: string; finished: boolean };
    expect(structured.status).toBe('RUNNING');
    expect(structured.finished).toBe(false);
  });

  it('fetch_dataset_items summary reports field fill rates without dumping data', async () => {
    const gateway = new FakeGateway(() => ({ items: [] }));
    const run = gateway.seedRun(
      [GOOD_PAGE, { ...GOOD_PAGE, markdown: '' }],
      {},
      'apify/cheerio-scraper',
    );
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'fetch_dataset_items',
      arguments: { dataset_id: run.datasetId },
    })) as StructuredResult;
    const structured = result.structuredContent as {
      total: number;
      returned: number;
      fields_seen: { field: string; fill_rate: number }[];
    };
    expect(structured.total).toBe(2);
    expect(structured.returned).toBe(0);
    const markdownField = structured.fields_seen.find((entry) => entry.field === 'markdown');
    expect(markdownField?.fill_rate).toBe(0.5);
  });

  it('fetch_dataset_items items mode enforces the token budget with a continuation offset', async () => {
    const gateway = new FakeGateway(() => ({ items: [] }));
    const bigItems = Array.from({ length: 20 }, (_, index) => ({
      url: `https://example.com/${index}`,
      text: `word ${index} `.repeat(400),
    }));
    const run = gateway.seedRun(bigItems, {}, 'apify/cheerio-scraper');
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'fetch_dataset_items',
      arguments: { dataset_id: run.datasetId, response_format: 'items', max_tokens: 2000 },
    })) as StructuredResult;
    const structured = result.structuredContent as {
      returned: number;
      truncated: boolean;
      next_offset: number | null;
    };
    expect(structured.truncated).toBe(true);
    expect(structured.returned).toBeGreaterThan(0);
    expect(structured.returned).toBeLessThan(20);
    expect(structured.next_offset).toBe(structured.returned);
  });

  it('validate_dataset scores against a caller-supplied JSON schema', async () => {
    const gateway = new FakeGateway(() => ({ items: [] }));
    const run = gateway.seedRun(
      [GOOD_PAGE, { url: 'https://example.com/b' }],
      {},
      'apify/cheerio-scraper',
    );
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'validate_dataset',
      arguments: {
        dataset_id: run.datasetId,
        json_schema: {
          type: 'object',
          required: ['url', 'text'],
          properties: { url: { type: 'string' }, text: { type: 'string', minLength: 10 } },
        },
      },
    })) as StructuredResult;
    const structured = result.structuredContent as {
      quality: { schema_pass_rate: number; sample_failures: string[] };
    };
    expect(structured.quality.schema_pass_rate).toBe(0.5);
    expect(structured.quality.sample_failures.length).toBeGreaterThan(0);
  });

  it('retry_low_quality_run escalates until quality clears the threshold', async () => {
    const scenario: Scenario = (_actor, input) => {
      const proxy = input.proxyConfiguration as { apifyProxyGroups?: string[] } | undefined;
      return proxy?.apifyProxyGroups?.includes('RESIDENTIAL')
        ? { items: [GOOD_PAGE] }
        : { items: [BLOCKED_PAGE] };
    };
    const gateway = new FakeGateway(scenario);
    const original = gateway.seedRun(
      [BLOCKED_PAGE],
      { startUrls: [{ url: 'https://example.com' }] },
      'apify/website-content-crawler',
    );
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'retry_low_quality_run',
      arguments: { run_id: original.runId, threshold: 0.8 },
    })) as StructuredResult;
    const structured = result.structuredContent as {
      reached_threshold: boolean;
      attempts: number;
      initial_quality: { score: number };
      final_quality: { score: number };
    };
    expect(structured.reached_threshold).toBe(true);
    expect(structured.attempts).toBe(1);
    expect(structured.final_quality.score).toBeGreaterThan(structured.initial_quality.score);
  });

  it('retry_low_quality_run reports failure when escalation cannot fix quality', async () => {
    const gateway = new FakeGateway(() => ({ items: [BLOCKED_PAGE] }));
    const original = gateway.seedRun(
      [BLOCKED_PAGE],
      { startUrls: [] },
      'apify/website-content-crawler',
    );
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'retry_low_quality_run',
      arguments: { run_id: original.runId, threshold: 0.9, max_attempts: 2 },
    })) as StructuredResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('blocking');
  });

  it('dataset_to_rag_documents emits chunked jsonl documents', async () => {
    const gateway = new FakeGateway(() => ({ items: [] }));
    const run = gateway.seedRun([GOOD_PAGE], {}, 'apify/cheerio-scraper');
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'dataset_to_rag_documents',
      arguments: { dataset_id: run.datasetId, metadata_fields: ['url'] },
    })) as StructuredResult;
    const structured = result.structuredContent as { documents: number; skipped_items: number };
    expect(structured.documents).toBe(1);
    expect(structured.skipped_items).toBe(0);
    const firstLine = result.content?.[0]?.text?.split('\n\n')[1]?.split('\n')[0];
    const doc = JSON.parse(firstLine ?? '{}') as { source: string; metadata: { url: string } };
    expect(doc.source).toBe('https://example.com/pricing');
    expect(doc.metadata.url).toBe('https://example.com/pricing');
  });
});
