/** Regression tests for defects found in adversarial review before the
 *  first release: stuck pagination on oversized items, silently dropped RAG
 *  documents under budget truncation, chunker bound violations, discarded
 *  best runs, and the SSRF IPv6-mapped bypass. */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_ACTORS, DEFAULT_LIMITS, type ServerConfig } from '../src/config.js';
import { chunkText } from '../src/core/chunker.js';
import { assertSafeUrl } from '../src/core/guards.js';
import { itemsToRagDocuments } from '../src/core/rag.js';
import { createServer } from '../src/server.js';
import { BLOCKED_PAGE, FakeGateway, GOOD_PAGE, type Scenario } from './fake-gateway.js';

const CONFIG: ServerConfig = { allowedActors: DEFAULT_ALLOWED_ACTORS, limits: DEFAULT_LIMITS };

let client: Client | undefined;

async function connect(gateway: FakeGateway, config: ServerConfig = CONFIG): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ gateway, config });
  client = new Client({ name: 'regression-harness', version: '1.0.0' });
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

describe('chunker strict token bound', () => {
  it('never exceeds maxTokens, even with overlap and separators', () => {
    const paragraphs = Array.from({ length: 12 }, () =>
      'A reasonably long paragraph about compliance obligations of providers. '.repeat(8),
    ).join('\n\n');
    for (const overlap of [0, 25, 50, 90]) {
      const chunks = chunkText(paragraphs, { maxTokens: 100, overlapTokens: overlap });
      for (const chunk of chunks) {
        expect(chunk.tokenCount).toBeLessThanOrEqual(100);
      }
    }
  });

  it('holds the bound at the tool extreme (512 max, 511 overlap rejected upstream, 256 used)', () => {
    const text = 'Sentence about data governance and audits. '.repeat(400);
    const chunks = chunkText(text, { maxTokens: 512, overlapTokens: 256 });
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(512);
    }
  });
});

describe('SSRF guard IPv6 forms', () => {
  it.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'http://[::ffff:10.0.0.5]/',
    'http://[::]/',
  ])('rejects %s', (url) => {
    expect(() => assertSafeUrl(url)).toThrow(/private or local/);
  });

  it('allows a public IPv4-mapped address', () => {
    expect(() => assertSafeUrl('http://[::ffff:93.184.216.34]/')).not.toThrow();
  });
});

describe('fetch_dataset_items oversized item', () => {
  it('advances past an item bigger than the whole token budget instead of looping', async () => {
    const gateway = new FakeGateway(() => ({ items: [] }));
    const giant = { url: 'https://example.com/giant', text: 'tok '.repeat(30_000) };
    const run = gateway.seedRun([giant, GOOD_PAGE], {}, 'apify/cheerio-scraper');
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'fetch_dataset_items',
      arguments: { dataset_id: run.datasetId, response_format: 'items', max_tokens: 1000 },
    })) as StructuredResult;
    const structured = result.structuredContent as {
      returned: number;
      next_offset: number | null;
      truncated: boolean;
    };
    expect(structured.returned).toBe(0);
    expect(structured.truncated).toBe(true);
    expect(structured.next_offset).toBe(1);
    expect(result.content?.[0]?.text).toContain('exceeds max_tokens');
  });
});

describe('dataset_to_rag_documents budget pagination', () => {
  const prose = (index: number) =>
    `Item ${index} body. ` +
    'This paragraph describes the product in enough detail to be embedded. '.repeat(12);

  it('emits only whole items and resumes exactly at the first unemitted item', async () => {
    const gateway = new FakeGateway(() => ({ items: [] }));
    const items = Array.from({ length: 10 }, (_, index) => ({
      url: `https://example.com/${index}`,
      text: prose(index),
    }));
    const run = gateway.seedRun(items, {}, 'apify/cheerio-scraper');
    const mcp = await connect(gateway);

    const first = (await mcp.callTool({
      name: 'dataset_to_rag_documents',
      arguments: { dataset_id: run.datasetId, max_response_tokens: 1000 },
    })) as StructuredResult;
    const firstStructured = first.structuredContent as {
      documents: number;
      truncated: boolean;
      next_offset: number | null;
    };
    expect(firstStructured.truncated).toBe(true);
    expect(firstStructured.documents).toBeGreaterThan(0);
    expect(firstStructured.next_offset).toBeGreaterThan(0);
    expect(firstStructured.next_offset).toBeLessThan(10);

    const emitted = new Set<string>();
    let offset: number | null = 0;
    let guard = 0;
    while (offset !== null && guard < 20) {
      guard++;
      const page = (await mcp.callTool({
        name: 'dataset_to_rag_documents',
        arguments: { dataset_id: run.datasetId, offset, max_response_tokens: 1000 },
      })) as StructuredResult;
      const body = page.content?.[0]?.text ?? '';
      for (const line of body.split('\n')) {
        if (line.startsWith('{')) {
          emitted.add((JSON.parse(line) as { source: string }).source);
        }
      }
      offset = (page.structuredContent as { next_offset: number | null }).next_offset;
    }
    expect(emitted.size).toBe(10);
  });

  it('skips an item that can never fit the budget with an explicit note', async () => {
    const gateway = new FakeGateway(() => ({ items: [] }));
    const items = [
      { url: 'https://example.com/huge', text: 'word '.repeat(20_000) },
      { url: 'https://example.com/ok', text: prose(1) },
    ];
    const run = gateway.seedRun(items, {}, 'apify/cheerio-scraper');
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'dataset_to_rag_documents',
      arguments: {
        dataset_id: run.datasetId,
        max_response_tokens: 1200,
        max_tokens_per_chunk: 512,
      },
    })) as StructuredResult;
    expect(result.content?.[0]?.text).toContain('exceed max_response_tokens');
    const body = result.content?.[0]?.text ?? '';
    expect(body).toContain('https://example.com/ok');
  });
});

describe('scrape_url best-run retention', () => {
  it('returns the successful low-quality run when every escalation fails', async () => {
    const scenario: Scenario = (_actor, _input, callNumber) => {
      if (callNumber === 1) return { items: [GOOD_PAGE, BLOCKED_PAGE, BLOCKED_PAGE] };
      if (callNumber === 2) return { items: [], error: 'no residential proxy access (403)' };
      return { status: 'TIMED-OUT', items: [] };
    };
    const gateway = new FakeGateway(scenario);
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'scrape_url',
      arguments: { url: 'https://example.com/pricing' },
    })) as StructuredResult;
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      run_id: string;
      attempts: number;
      quality: { score: number };
    };
    expect(structured.run_id).toBe('run-1');
    expect(structured.attempts).toBe(3);
    expect(result.content?.[0]?.text).toContain('LOW QUALITY');
  });

  it('fails with the last error when no attempt ever succeeds', async () => {
    const gateway = new FakeGateway(() => ({ items: [], error: 'account blocked (403)' }));
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'scrape_url',
      arguments: { url: 'https://example.com' },
    })) as StructuredResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('account blocked');
  });

  it('respects the operator allowlist for the built-in crawler', async () => {
    const gateway = new FakeGateway(() => ({ items: [GOOD_PAGE] }));
    const mcp = await connect(gateway, {
      allowedActors: ['apify/cheerio-scraper'],
      limits: DEFAULT_LIMITS,
    });
    const result = (await mcp.callTool({
      name: 'scrape_url',
      arguments: { url: 'https://example.com' },
    })) as StructuredResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('not on the allowlist');
    expect(gateway.calls).toHaveLength(0);
  });
});

describe('retry_low_quality_run resilience', () => {
  it('reports the best run and the failure reasons when escalations throw', async () => {
    const gateway = new FakeGateway(() => ({ items: [], error: 'proxy group unavailable' }));
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
    const structured = result.structuredContent as {
      final_run_id: string;
      attempts: number;
    };
    expect(structured.final_run_id).toBe(original.runId);
    expect(structured.attempts).toBe(2);
    expect(result.content?.[0]?.text).toContain('proxy group unavailable');
  });
});

describe('rag document item indexing', () => {
  it('carries the page item index on every document', () => {
    const { documents } = itemsToRagDocuments(
      [
        { text: 'First item content long enough to pass the prose floor for detection here.' },
        { price: 3 },
        { text: 'Third item content long enough to pass the prose floor for detection here.' },
      ],
      { maxTokens: 512, overlapTokens: 0 },
    );
    expect(documents.map((doc) => doc.itemIndex)).toEqual([0, 2]);
  });
});
