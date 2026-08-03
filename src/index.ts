import { constants } from 'node:os';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { configFromEnv } from './config.js';
import { createApifyGateway } from './core/apify.js';
import type { ServerDeps } from './deps.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { shutdownTracing, startTracing } from './tracing.js';
import { serveHttp } from './transports/http.js';

const USAGE =
  'Usage: web-data-mcp [--transport stdio|http] [--port 3000]\n\n' +
  'Env:\n' +
  '  APIFY_TOKEN                    required\n' +
  '  WEB_DATA_MCP_ALLOWED_ACTORS    optional comma-separated actor allowlist\n' +
  '  WEB_DATA_MCP_HTTP_TOKEN        required for --transport http\n' +
  '  OTEL_EXPORTER_OTLP_ENDPOINT    optional OTLP/HTTP collector; enables tracing\n' +
  '                                 (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT overrides it)';

/**
 * parseArgs throws on an unknown flag, a positional, or a flag missing its value
 * — `-h` alone hits it, since only the long form is declared. Uncaught inside an
 * async main that nothing awaits, that surfaces as an unhandled rejection: a Node
 * stack trace out of node:internal, from a binary whose other two argument errors
 * are one actionable line each. Usage is printed rather than "run --help",
 * because for `-h` the suggestion would be the command that just failed.
 */
function parseCli(): { transport: string; port: string; help: boolean } {
  try {
    return parseArgs({
      options: {
        transport: { type: 'string', default: 'stdio' },
        port: { type: 'string', default: '3000' },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const values = parseCli();

  if (values.help) {
    console.error(USAGE);
    process.exit(0);
  }

  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.error(
      'APIFY_TOKEN is not set. Get one at https://console.apify.com/settings/integrations',
    );
    process.exit(1);
  }

  const tracing = await startTracing(SERVER_NAME, SERVER_VERSION);

  const deps: ServerDeps = {
    gateway: createApifyGateway(token),
    config: configFromEnv(),
  };

  if (values.transport === 'http') {
    const httpToken = process.env.WEB_DATA_MCP_HTTP_TOKEN;
    if (!httpToken) {
      console.error('WEB_DATA_MCP_HTTP_TOKEN must be set for the http transport.');
      process.exit(1);
    }
    const port = Number.parseInt(values.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`Invalid --port "${values.port}" — expected an integer between 1 and 65535.`);
      process.exit(1);
    }
    serveHttp(deps, { port, token: httpToken });
    return;
  }

  if (values.transport !== 'stdio') {
    console.error(`Unknown transport "${values.transport}" — use stdio or http.`);
    process.exit(1);
  }

  if (tracing) {
    // Tracing must not change when this process dies. An MCP client stops a stdio
    // server by closing its stdin and only escalates to a signal if that does not
    // take; either way an exporter still retrying against a dead collector would
    // otherwise hold the event loop open long past the client's patience.
    //
    // A signal-killed process exits 128+signum, which is what Node does with no
    // handler installed. Exiting 0 instead would make the code an operator sees
    // depend on whether a telemetry variable happens to be set.
    const stop = (code: number): void => {
      void shutdownTracing().finally(() => process.exit(code));
    };
    process.stdin.once('end', () => stop(0));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => stop(128 + constants.signals[signal]));
    }
  }

  void serveStdio(() => createServer(deps));
  console.error('web-data-mcp running on stdio');
}

void main();
