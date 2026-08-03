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
