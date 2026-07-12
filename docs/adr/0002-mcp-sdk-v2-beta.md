# ADR 0002: Build on MCP TypeScript SDK v2 (beta) rather than v1

**Status:** accepted · 2026-07-12

## Context

At the time of writing, `@modelcontextprotocol/sdk` v1.29 is the last stable v1 release, and `@modelcontextprotocol/server` 2.0.0-beta.3 implements the 2026-07-28 spec revision, with the stable v2 expected within weeks. The SDK's own guidance is to start new servers on v2.

## Decision

Pin `@modelcontextprotocol/server@2.0.0-beta.3` (plus matching `node`/`client` packages) and use the v2 API surface: `registerTool` config objects, Zod 4 schemas, `serveStdio` factories, and `createMcpHandler` for Streamable HTTP. Keep everything behind a `createServer(deps)` factory so a v1 fallback would only touch the entry points.

## Consequences

- Legacy 2025-era clients (Claude Desktop, Cursor) still work: the v2 handler serves them via its built-in fallback (`legacy: 'stateless'` on HTTP, `legacy: 'serve'` on stdio).
- The pinned beta must be bumped to v2 stable when it lands; the version is pinned exactly so the upgrade is a deliberate commit.
- SSE transport code is gone in v2, so this server never has to carry that migration.
