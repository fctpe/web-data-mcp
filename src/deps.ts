import type { ServerConfig } from './config.js';
import type { ApifyGateway } from './core/apify.js';

export interface ServerDeps {
  gateway: ApifyGateway;
  config: ServerConfig;
}
