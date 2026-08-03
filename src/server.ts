import { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from './deps.js';
import { registerDatasetToRagDocuments } from './tools/dataset-to-rag-documents.js';
import { registerFetchDatasetItems } from './tools/fetch-dataset-items.js';
import { registerGetRunStatus } from './tools/get-run-status.js';
import { registerRetryLowQualityRun } from './tools/retry-low-quality-run.js';
import { registerRunActor } from './tools/run-actor.js';
import { registerScrapeUrl } from './tools/scrape-url.js';
import { registerValidateDataset } from './tools/validate-dataset.js';
import { traceToolCalls } from './tracing.js';

export const SERVER_NAME = 'web-data-mcp';
export const SERVER_VERSION = '0.1.0';

export function createServer(deps: ServerDeps): McpServer {
  const server = traceToolCalls(new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }));
  registerScrapeUrl(server, deps);
  registerRunActor(server, deps);
  registerGetRunStatus(server, deps);
  registerFetchDatasetItems(server, deps);
  registerValidateDataset(server, deps);
  registerRetryLowQualityRun(server, deps);
  registerDatasetToRagDocuments(server, deps);
  return server;
}
