import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { DEFAULT_ALLOWED_ACTORS, DEFAULT_LIMITS } from '../src/config.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from '../src/server.js';
import { shutdownTracing, startTracing, traceToolCalls } from '../src/tracing.js';
import { BLOCKED_PAGE, FakeGateway, GOOD_PAGE } from './fake-gateway.js';

const CONFIG = { allowedActors: DEFAULT_ALLOWED_ACTORS, limits: DEFAULT_LIMITS };

interface OtlpSpan {
  name: string;
  status?: { code?: number; message?: string };
  attributes: { key: string; value: Record<string, unknown> }[];
  events?: { name: string; attributes?: { key: string; value: Record<string, unknown> }[] }[];
}

/** Stands in for an OTLP/HTTP collector and records what the exporter posted. */
class Collector {
  readonly paths: string[] = [];
  readonly spans: OtlpSpan[] = [];
  /** Status to answer with; 401 is the "collector rejects us" case and is not retried. */
  status = 200;
  /** Accept the POST and never answer it, so an export stays in flight forever. */
  hang = false;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  async start(): Promise<string> {
    this.server = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        this.paths.push(req.url ?? '');
        if (this.hang) return;
        if (this.status === 200) {
          const payload = JSON.parse(body) as {
            resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
          };
          for (const resourceSpan of payload.resourceSpans) {
            for (const scopeSpan of resourceSpan.scopeSpans) this.spans.push(...scopeSpan.spans);
          }
        }
        res.writeHead(this.status, { 'content-type': 'application/json' }).end('{}');
      });
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    // A hung request outlives close(); drop the socket or the suite waits out the
    // exporter's own 10s timeout.
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  span(name: string): OtlpSpan | undefined {
    return this.spans.find((candidate) => candidate.name === name);
  }

  attribute(spanName: string, key: string): unknown {
    return this.span(spanName)?.attributes.find((attr) => attr.key === key)?.value;
  }

  /** Polls instead of sleeping a fixed time, so a slow machine reads as slow, not broken. */
  async waitForSpan(name: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.spans.some((span) => span.name === name)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no span named "${name}" reached the collector within ${timeoutMs}ms`);
  }

  /** OTLP/JSON encodes whole numbers as intValue and the rest as doubleValue. */
  numericAttribute(spanName: string, key: string): number | undefined {
    const value = this.attribute(spanName, key) as
      | { doubleValue?: number; intValue?: number }
      | undefined;
    return value?.doubleValue ?? value?.intValue;
  }
}

let collector: Collector;
let client: Client | undefined;
let endpoint: string;

async function connect(gateway: FakeGateway): Promise<Client> {
  return connectTo(createServer({ gateway, config: CONFIG }));
}

async function connectTo(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'tracing-harness', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function start(): Promise<boolean> {
  return startTracing(SERVER_NAME, SERVER_VERSION);
}

beforeEach(async () => {
  collector = new Collector();
  endpoint = await collector.start();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  // shutdownTracing also flushes, so every test must await it before asserting.
  await shutdownTracing();
  await collector.stop();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  vi.restoreAllMocks();
});

describe('opt-in tracing', () => {
  it('is a hard no-op without OTEL_EXPORTER_OTLP_ENDPOINT', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(await start()).toBe(false);

    const mcp = await connect(new FakeGateway(() => ({ items: [GOOD_PAGE] })));
    await mcp.callTool({ name: 'scrape_url', arguments: { url: 'https://example.com/pricing' } });
    await shutdownTracing();

    expect(collector.paths).toEqual([]);
    expect(collector.spans).toEqual([]);
  });

  it('exports one span per tool call over OTLP/HTTP with GenAI attributes', async () => {
    expect(await start()).toBe(true);

    const mcp = await connect(new FakeGateway(() => ({ items: [GOOD_PAGE] })));
    await mcp.callTool({ name: 'scrape_url', arguments: { url: 'https://example.com/pricing' } });
    await shutdownTracing();

    expect(collector.paths).toEqual(['/v1/traces']);
    expect(collector.spans.map((span) => span.name)).toEqual(['execute_tool scrape_url']);
    expect(collector.attribute('execute_tool scrape_url', 'gen_ai.operation.name')).toEqual({
      stringValue: 'execute_tool',
    });
    expect(collector.attribute('execute_tool scrape_url', 'gen_ai.tool.name')).toEqual({
      stringValue: 'scrape_url',
    });
  });

  it('exports a span when it ends rather than buffering it', async () => {
    await start();

    const mcp = await connect(new FakeGateway(() => ({ items: [GOOD_PAGE] })));
    await mcp.callTool({ name: 'scrape_url', arguments: { url: 'https://example.com/pricing' } });

    // Deliberately no shutdownTracing(): SimpleSpanProcessor POSTs on span end, so
    // the span is queryable before anything asks the provider to flush.
    await collector.waitForSpan('execute_tool scrape_url');
  });

  it('carries the tool quality score as a span attribute', async () => {
    await start();

    const gateway = new FakeGateway(() => ({ items: [] }));
    const run = gateway.seedRun([GOOD_PAGE], {}, 'apify/cheerio-scraper');
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'validate_dataset',
      arguments: { dataset_id: run.datasetId },
    })) as { structuredContent: { quality: { score: number } } };
    await shutdownTracing();

    expect(
      collector.numericAttribute('execute_tool validate_dataset', 'web_data_mcp.quality.score'),
    ).toBe(result.structuredContent.quality.score);
  });

  it('refuses a non-http endpoint instead of exporting into the void', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'localhost:4318';
    expect(await start()).toBe(false);
  });

  it('reads final_quality for retry_low_quality_run and marks the span as an error', async () => {
    await start();

    const gateway = new FakeGateway(() => ({ items: [BLOCKED_PAGE] }));
    const original = gateway.seedRun(
      [BLOCKED_PAGE],
      { startUrls: [] },
      'apify/website-content-crawler',
    );
    const mcp = await connect(gateway);
    const result = (await mcp.callTool({
      name: 'retry_low_quality_run',
      arguments: { run_id: original.runId, threshold: 0.9, max_attempts: 1 },
    })) as { isError: boolean; structuredContent: { final_quality: { score: number } } };
    await shutdownTracing();

    expect(result.isError).toBe(true);
    const name = 'execute_tool retry_low_quality_run';
    expect(collector.numericAttribute(name, 'web_data_mcp.quality.score')).toBe(
      result.structuredContent.final_quality.score,
    );
    // SpanStatusCode.ERROR
    expect(collector.span(name)?.status?.code).toBe(2);
  });

  it('leaves tool results untouched when tracing is on', async () => {
    await start();

    const mcp = await connect(new FakeGateway(() => ({ items: [GOOD_PAGE] })));
    const result = (await mcp.callTool({
      name: 'scrape_url',
      arguments: { url: 'https://example.com/pricing' },
    })) as { isError?: boolean; structuredContent: { quality: { score: number } } };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.quality.score).toBeGreaterThanOrEqual(0.7);
  });
});

/**
 * The guard has to read the endpoint the exporter will actually use. It reads
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT first and OTEL_EXPORTER_OTLP_ENDPOINT second;
 * checking only the latter both refused a legal configuration and waved through an
 * illegal one.
 */
describe('endpoint guard follows the exporter, not just the base variable', () => {
  it('traces on OTEL_EXPORTER_OTLP_TRACES_ENDPOINT alone', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${endpoint}/v1/traces`;
    expect(await start()).toBe(true);

    const mcp = await connect(new FakeGateway(() => ({ items: [GOOD_PAGE] })));
    await mcp.callTool({ name: 'scrape_url', arguments: { url: 'https://example.com/pricing' } });
    await shutdownTracing();

    expect(collector.spans.map((span) => span.name)).toEqual(['execute_tool scrape_url']);
  });

  it('refuses a non-http traces endpoint that overrides a valid base endpoint', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'grpc://localhost:4317';

    expect(await start()).toBe(false);
    expect(stderr.mock.calls.flat().join(' ')).toContain('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
  });

  it('falls back to the base endpoint when the traces override is blank', async () => {
    // getStringFromEnv counts a whitespace-only value as unset; so must the guard,
    // or an empty override would refuse a configuration the exporter honours.
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = '   ';
    expect(await start()).toBe(true);

    const mcp = await connect(new FakeGateway(() => ({ items: [GOOD_PAGE] })));
    await mcp.callTool({ name: 'scrape_url', arguments: { url: 'https://example.com/pricing' } });
    await shutdownTracing();

    expect(collector.spans.map((span) => span.name)).toEqual(['execute_tool scrape_url']);
  });
});

describe('export failures are audible on stderr', () => {
  it('reports a collector that rejects the export', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    collector.status = 401;
    await start();

    const mcp = await connect(new FakeGateway(() => ({ items: [GOOD_PAGE] })));
    await mcp.callTool({ name: 'scrape_url', arguments: { url: 'https://example.com/pricing' } });
    await shutdownTracing();

    expect(collector.paths).toEqual(['/v1/traces']);
    expect(collector.spans).toEqual([]);
    expect(stderr.mock.calls.flat().join(' ')).toContain('401');
  });

  it('says so when the shutdown grace period expires with exports in flight', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    collector.hang = true;
    await start();

    const mcp = await connect(new FakeGateway(() => ({ items: [GOOD_PAGE] })));
    await mcp.callTool({ name: 'scrape_url', arguments: { url: 'https://example.com/pricing' } });
    await shutdownTracing();

    expect(stderr.mock.calls.flat().join(' ')).toContain('Tracing shutdown dropped spans');
  }, 10_000);
});

/**
 * SECURITY.md promises APIFY_TOKEN never reaches an error message. Every tool
 * returns toolFailure(err) with a message that went through mapApifyError, so a raw
 * throw recorded on the span would be the one way an unsanitized message and stack
 * left the process for an external collector.
 */
describe('a raw throw is never recorded on a span', () => {
  it('exports the span without an exception event or the thrown text', async () => {
    const secret = 'apify_api_TOPSECRETVALUE';
    await start();

    const server = traceToolCalls(new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }));
    server.registerTool(
      'boom',
      { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) },
      () => {
        throw new Error(`unsanitized failure carrying ${secret}`);
      },
    );
    const mcp = await connectTo(server);
    await mcp.callTool({ name: 'boom', arguments: {} }).catch(() => undefined);
    await shutdownTracing();

    const span = collector.span('execute_tool boom');
    expect(span).toBeDefined();
    expect(span?.events ?? []).toEqual([]);
    expect(JSON.stringify(span)).not.toContain(secret);
  });
});
