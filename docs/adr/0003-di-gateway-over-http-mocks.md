# ADR 0003: Dependency-injected Apify gateway instead of HTTP-level mocks

**Status:** accepted · 2026-07-12

## Context

Tool logic (quality gating, escalation, pagination, token budgeting) needs tests that model multi-run scenarios like "blocked on datacenter proxies, clean on residential". Mocking at the HTTP layer (msw/nock) couples tests to `apify-client`'s private wire format and breaks silently when the client library changes.

## Decision

Define a small `ApifyGateway` interface (`src/core/apify.ts`) as the only seam to the Apify API. Production wires `createApifyGateway(token)`; tests inject `FakeGateway`, an in-memory implementation whose scenario callback decides per-call what a "run" returns.

## Consequences

- The entire test suite (52 tests) runs offline in under a second, including full client↔server integration through `InMemoryTransport`.
- The real gateway is intentionally thin — error mapping and retries only — so the untested surface is small; one live smoke test against `apify/hello-world` covers the wiring before releases.
- Upstream API changes surface in exactly one file.
