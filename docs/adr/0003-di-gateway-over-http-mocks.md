# ADR 0003: Dependency-injected Apify gateway instead of HTTP-level mocks

**Status:** accepted · 2026-07-12

## Context

Tool logic (quality gating, escalation, pagination, token budgeting) needs tests that model multi-run scenarios like "blocked on datacenter proxies, clean on residential". Mocking at the HTTP layer (msw/nock) couples tests to `apify-client`'s private wire format and breaks silently when the client library changes.

## Decision

Define a small `ApifyGateway` interface (`src/core/apify.ts`) as the only seam to the Apify API. Production wires `createApifyGateway(token)`; tests inject `FakeGateway`, an in-memory implementation whose scenario callback decides per-call what a "run" returns.

## Consequences

- The entire test suite runs offline in under a second, including full client↔server integration through `InMemoryTransport`.
- The real gateway is intentionally thin — error mapping and retries only — so the untested surface is small; `scripts/live-smoke.mjs` exercises the full flow against a real actor before releases (see the README's pressure-test results for what live runs caught that mocks could not).
- Upstream API changes surface in exactly one file.
