# ADR 0004: Hard response token budgets and explicit handles

**Status:** accepted · 2026-07-12

## Context

Scraped datasets are arbitrarily large; dumping them into a tool result silently eats the calling agent's context window. Anthropic's tool-design guidance recommends response caps (~25k tokens) with `response_format` controls, and the 2026 MCP spec direction favors stateless servers where the model threads explicit ids between calls.

## Decision

Every data-bearing tool measures its output with the same tokenizer used for chunking (`js-tiktoken`, cl100k) and stops at a caller-tunable budget, returning `truncated` plus a `next_offset` continuation. Runs and datasets are addressed by explicit `run_id`/`dataset_id` handles returned from every tool that creates them; the server keeps no session state.

## Consequences

- An agent can never blow its context by calling `fetch_dataset_items` on a 100k-item dataset; it gets a summary mode, field projection, and pagination instead.
- Item boundaries are respected when budgeting, so the model always receives parseable JSON.
- Statelessness means the server works identically over stdio, HTTP, and in horizontally scaled deployments.
