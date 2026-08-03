import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { constants } from 'node:os';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../deps.js';
import { createServer } from '../server.js';
import { shutdownTracing } from '../tracing.js';

function constantTimeEquals(a: string, b: string): boolean {
  // Hash both sides first so the comparison never branches on input length.
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Streamable HTTP transport bound to loopback, with DNS-rebinding guards and
 * a required bearer token. The token comparison is constant-time.
 */
export function serveHttp(deps: ServerDeps, opts: { port: number; token: string }): void {
  const handler = createMcpHandler(() => createServer(deps));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = createHttpServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!constantTimeEquals(bearer, opts.token)) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    void nodeHandler(req, res);
  });

  httpServer.listen(opts.port, '127.0.0.1', () => {
    console.error(`web-data-mcp listening on http://127.0.0.1:${opts.port}/mcp`);
  });

  // SIGTERM as well as SIGINT: it is what Docker and Kubernetes send, and handling
  // only SIGINT killed the process outright there — no handler.close(), no flush.
  // Exit 128+signum, the code Node produces when no handler is installed at all.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      httpServer.close();
      void handler
        .close()
        .finally(shutdownTracing)
        .finally(() => process.exit(128 + constants.signals[signal]));
    });
  }
}
