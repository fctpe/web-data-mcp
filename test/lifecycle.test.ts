/** Regression tests for how the process starts, stops, and is wired together:
 *  signal handling on both transports, the exit code a supervisor reads, the
 *  module boundary that keeps tracing loadable on its own, and the CI/release
 *  parity that decides whether the shipped artifact was ever smoke-tested. */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));

/** A port nothing is listening on, so startTracing() accepts the URL and exports fail fast. */
async function freePort(): Promise<number> {
  const probe = createHttpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
});

/**
 * Spawns the server and resolves once `ready` shows up on stderr. `--import tsx`
 * rather than the tsx binary: that one is a wrapper process that takes the signal
 * itself and reports its own exit code, which hides the server's entirely.
 */
async function spawnServer(args: string[], env: NodeJS.ProcessEnv, ready: string): Promise<void> {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: repo,
    env: { ...process.env, APIFY_TOKEN: 'lifecycle-placeholder', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const proc = child;
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.includes(ready)) resolve();
    });
    proc.once('exit', (code) => reject(new Error(`exited early (${code}): ${stderr}`)));
    setTimeout(() => reject(new Error(`never printed "${ready}": ${stderr}`)), 20_000);
  });
}

function exitStatus(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const proc = child;
  if (!proc) throw new Error('no child process');
  return new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

/**
 * A signal-terminated process exits 128+signum. Exiting 0 tells a supervisor the
 * shutdown was voluntary, and until the stop handler was fixed the code an operator
 * saw depended on whether a telemetry variable happened to be set.
 */
describe('exit code after a signal', () => {
  it('stdio with tracing on exits 130 on SIGINT, not 0', async () => {
    const port = await freePort();
    await spawnServer(
      [],
      { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` },
      'web-data-mcp running on stdio',
    );

    const exited = exitStatus();
    child?.kill('SIGINT');
    expect(await exited).toEqual({ code: 130, signal: null });
  }, 30_000);

  it('http exits 130 on SIGINT, not 0', async () => {
    const port = await freePort();
    await spawnServer(
      ['--transport', 'http', '--port', String(port)],
      { WEB_DATA_MCP_HTTP_TOKEN: 'lifecycle-token' },
      'listening on http://127.0.0.1:',
    );

    const exited = exitStatus();
    child?.kill('SIGINT');
    expect(await exited).toEqual({ code: 130, signal: null });
  }, 30_000);

  /**
   * SIGTERM is what Docker and Kubernetes send. Handling only SIGINT let Node kill
   * the process outright — same 143, but with no handler.close() and no flush — so
   * the exit code alone cannot tell the two apart. The handler running is what can:
   * an unhandled SIGTERM is reported as a signal, a handled one as a code.
   */
  it('http shuts down through its own handler on SIGTERM', async () => {
    const port = await freePort();
    await spawnServer(
      ['--transport', 'http', '--port', String(port)],
      { WEB_DATA_MCP_HTTP_TOKEN: 'lifecycle-token' },
      'listening on http://127.0.0.1:',
    );

    const exited = exitStatus();
    child?.kill('SIGTERM');
    expect(await exited).toEqual({ code: 143, signal: null });
  }, 30_000);
});

/**
 * The tests above only prove the HTTP server *starts* — they wait for the
 * listening line and then send it a signal. Nothing ever went through the
 * handler, so the whole hono request path was untested, and a transitive
 * `@hono/node-server` bump across a major (1.19 -> 2.1, taken to clear
 * GHSA-frvp-7c67-39w9) would have gone green while serving 500s to every real
 * client. One round trip over the wire is what the startup assertion cannot
 * substitute for.
 */
describe('http transport serves a real request', () => {
  async function serve(): Promise<{ url: string; token: string }> {
    const port = await freePort();
    const token = 'round-trip-token';
    await spawnServer(
      ['--transport', 'http', '--port', String(port)],
      { WEB_DATA_MCP_HTTP_TOKEN: token },
      'listening on http://127.0.0.1:',
    );
    return { url: `http://127.0.0.1:${port}/mcp`, token };
  }

  function rpc(url: string, token: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'lifecycle-test', version: '0' },
    },
  };

  /** Responses come back as SSE frames, so the JSON is behind a `data:` line. */
  function parseRpc(text: string): { result?: { tools?: { name: string }[] } } {
    const frame = text.includes('data: ') ? text.split('data: ').pop()?.trim() : text;
    return JSON.parse(frame ?? '{}');
  }

  it('answers tools/list over the wire with every tool the stdio server exposes', async () => {
    const { url, token } = await serve();
    const init = await rpc(url, token, INITIALIZE);
    expect(init.status).toBe(200);

    const listed = await rpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(listed.status).toBe(200);
    const tools = parseRpc(await listed.text()).result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'dataset_to_rag_documents',
      'fetch_dataset_items',
      'get_run_status',
      'retry_low_quality_run',
      'run_actor',
      'scrape_url',
      'validate_dataset',
    ]);
  }, 30_000);

  /**
   * Negative control for the test above. If the bearer check ever stopped
   * running, `tools/list` would still return seven tools and that assertion
   * would still pass — while the server answered anyone who asked.
   */
  it('rejects a wrong bearer token before the handler sees the request', async () => {
    const { url } = await serve();
    const denied = await rpc(url, 'not-the-token', INITIALIZE);
    expect(denied.status).toBe(401);
    expect(await denied.text()).toContain('unauthorized');
  }, 30_000);
});

/**
 * server.ts imports traceToolCalls from tracing.ts. tracing.ts importing
 * SERVER_NAME/SERVER_VERSION back from server.ts closed the loop, and only the
 * laziness of the read kept it working. The name and version are arguments now.
 */
describe('module boundaries', () => {
  it('tracing.ts does not import from server.ts', () => {
    const source = readFileSync(`${repo}src/tracing.ts`, 'utf8');
    expect(source).not.toMatch(/from '\.\/server\.js'/);
  });
});

/**
 * The stdio smoke is the only check that drives the built dist/ over a real protocol
 * stream. It gated main while the tag that shipped to npm skipped it entirely.
 */
describe('CI and release run the same smoke', () => {
  it('both workflows run scripts/stdio-smoke.mjs', () => {
    for (const workflow of ['ci.yml', 'release.yml']) {
      const source = readFileSync(`${repo}.github/workflows/${workflow}`, 'utf8');
      expect(source, workflow).toContain('node scripts/stdio-smoke.mjs');
    }
  });
});
