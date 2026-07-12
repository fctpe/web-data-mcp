import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { configFromEnv } from './config.js';
import { createApifyGateway } from './core/apify.js';
import type { ServerDeps } from './deps.js';
import { createServer } from './server.js';
import { serveHttp } from './transports/http.js';

function main(): void {
  const { values } = parseArgs({
    options: {
      transport: { type: 'string', default: 'stdio' },
      port: { type: 'string', default: '3000' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.error(
      'Usage: web-data-mcp [--transport stdio|http] [--port 3000]\n\n' +
        'Env:\n' +
        '  APIFY_TOKEN                    required\n' +
        '  WEB_DATA_MCP_ALLOWED_ACTORS    optional comma-separated actor allowlist\n' +
        '  WEB_DATA_MCP_HTTP_TOKEN        required for --transport http',
    );
    process.exit(0);
  }

  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.error(
      'APIFY_TOKEN is not set. Get one at https://console.apify.com/settings/integrations',
    );
    process.exit(1);
  }

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

  void serveStdio(() => createServer(deps));
  console.error('web-data-mcp running on stdio');
}

main();
