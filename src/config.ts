export interface ServerConfig {
  allowedActors: readonly string[];
  limits: {
    maxItemsPerPage: number;
    maxWaitSecs: number;
    maxMemoryMb: number;
    maxTimeoutSecs: number;
    maxResponseTokens: number;
    maxValidationSample: number;
  };
}

export const DEFAULT_ALLOWED_ACTORS = [
  'apify/website-content-crawler',
  'apify/cheerio-scraper',
  'apify/rag-web-browser',
  'apify/google-search-scraper',
  'apify/hello-world',
] as const;

export const DEFAULT_LIMITS: ServerConfig['limits'] = {
  maxItemsPerPage: 200,
  maxWaitSecs: 300,
  maxMemoryMb: 4096,
  maxTimeoutSecs: 900,
  maxResponseTokens: 25_000,
  maxValidationSample: 500,
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const allowlistRaw = env.WEB_DATA_MCP_ALLOWED_ACTORS;
  const allowedActors = allowlistRaw
    ? allowlistRaw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [...DEFAULT_ALLOWED_ACTORS];

  return { allowedActors, limits: DEFAULT_LIMITS };
}
