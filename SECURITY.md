# Security

## Token handling

- `APIFY_TOKEN` is read from the environment once at startup, passed only to the official `apify-client`, and never logged, echoed into tool results, or included in error messages (see `src/core/errors.ts`).
- The Streamable HTTP transport requires a bearer token (`WEB_DATA_MCP_HTTP_TOKEN`), compared in constant time, and binds to `127.0.0.1` with Host/Origin validation in front of the handler to prevent DNS rebinding.
- stdio mode logs to stderr only; stdout is reserved for the protocol stream.

## Abuse guards

- Actors can only be started from an explicit allowlist (`WEB_DATA_MCP_ALLOWED_ACTORS`).
- `scrape_url` rejects non-http(s) schemes and private/loopback/link-local hosts, so an agent cannot point the scraper at internal infrastructure or cloud metadata endpoints.
- Run memory, timeouts, page sizes, and response token budgets are clamped server-side regardless of what the model requests.

## Reporting

Open a GitHub security advisory or email the address on the profile of [@fctpe](https://github.com/fctpe). Please do not open public issues for vulnerabilities.
