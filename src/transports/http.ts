import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../deps.js';
import { createServer } from '../server.js';

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
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

  process.on('SIGINT', () => {
    httpServer.close();
    void handler.close().finally(() => process.exit(0));
  });
}
