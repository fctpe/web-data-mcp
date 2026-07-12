# ADR 0001: Curated quality-gated tools instead of dynamic actor discovery

**Status:** accepted · 2026-07-12

## Context

The official `apify/apify-mcp-server` already exposes the full Apify store (5,000+ actors) through dynamic discovery tools. Duplicating that would add nothing, and dynamically registering thousands of tools pollutes the model's context window and pushes input-schema errors to runtime.

## Decision

Ship 7 hand-designed tools around one workflow — get *trustworthy* web data into an agent: consolidated `scrape_url` (run + wait + score + auto-retry in one call), explicit run/dataset handles, schema validation, quality scoring, escalating retries, and RAG-ready chunk output. Arbitrary actors are still reachable through `run_actor`, but only from an operator-controlled allowlist.

## Consequences

- The server stays small enough that every tool description can be prompt-engineered and tested.
- Users who need the whole Apify store should use the official server; the README says so explicitly.
- New capabilities are added as parameters on existing tools before new tools are considered (fewer, higher-leverage tools per Anthropic's tool-design guidance).
