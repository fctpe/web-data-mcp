import { ApifyClient } from 'apify-client';
import { mapApifyError } from './errors.js';
import { withRetry } from './retry.js';

export type RunStatus =
  | 'READY'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMING-OUT'
  | 'TIMED-OUT'
  | 'ABORTING'
  | 'ABORTED';

export interface RunInfo {
  runId: string;
  actorId: string;
  status: RunStatus;
  datasetId: string | null;
  keyValueStoreId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  statusMessage: string | null;
}

export interface DatasetPage {
  items: unknown[];
  total: number;
  offset: number;
  count: number;
}

export interface RunOptions {
  memoryMb?: number;
  timeoutSecs?: number;
  waitSecs?: number;
}

export interface ApifyGateway {
  callActor(actorId: string, input: Record<string, unknown>, opts?: RunOptions): Promise<RunInfo>;
  startActor(actorId: string, input: Record<string, unknown>, opts?: RunOptions): Promise<RunInfo>;
  getRun(runId: string): Promise<RunInfo | null>;
  listDatasetItems(
    datasetId: string,
    opts: { offset?: number; limit?: number; fields?: string[] },
  ): Promise<DatasetPage>;
  getRunInput(runId: string): Promise<Record<string, unknown> | null>;
}

interface RawRun {
  id: string;
  actId: string;
  status: string;
  defaultDatasetId?: string;
  defaultKeyValueStoreId?: string;
  startedAt?: Date | string;
  finishedAt?: Date | string;
  statusMessage?: string;
}

function toRunInfo(run: RawRun): RunInfo {
  return {
    runId: run.id,
    actorId: run.actId,
    status: run.status as RunStatus,
    datasetId: run.defaultDatasetId ?? null,
    keyValueStoreId: run.defaultKeyValueStoreId ?? null,
    startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    statusMessage: run.statusMessage ?? null,
  };
}

export function createApifyGateway(token: string): ApifyGateway {
  const client = new ApifyClient({ token });

  return {
    async callActor(actorId, input, opts = {}) {
      try {
        const run = await client.actor(actorId).call(input, {
          ...(opts.memoryMb !== undefined && { memory: opts.memoryMb }),
          ...(opts.timeoutSecs !== undefined && { timeout: opts.timeoutSecs }),
          ...(opts.waitSecs !== undefined && { waitSecs: opts.waitSecs }),
        });
        return toRunInfo(run as unknown as RawRun);
      } catch (err) {
        throw mapApifyError(err, `Running actor ${actorId}`);
      }
    },

    async startActor(actorId, input, opts = {}) {
      try {
        const run = await client.actor(actorId).start(input, {
          ...(opts.memoryMb !== undefined && { memory: opts.memoryMb }),
          ...(opts.timeoutSecs !== undefined && { timeout: opts.timeoutSecs }),
        });
        return toRunInfo(run as unknown as RawRun);
      } catch (err) {
        throw mapApifyError(err, `Starting actor ${actorId}`);
      }
    },

    async getRun(runId) {
      try {
        const run = await withRetry(() => client.run(runId).get());
        return run ? toRunInfo(run as unknown as RawRun) : null;
      } catch (err) {
        throw mapApifyError(err, `Fetching run ${runId}`);
      }
    },

    async listDatasetItems(datasetId, opts) {
      try {
        const page = await withRetry(() =>
          client.dataset(datasetId).listItems({
            clean: true,
            offset: opts.offset ?? 0,
            limit: opts.limit ?? 100,
            ...(opts.fields !== undefined && opts.fields.length > 0 && { fields: opts.fields }),
          }),
        );
        return {
          items: page.items as unknown[],
          total: page.total,
          offset: page.offset,
          count: page.count,
        };
      } catch (err) {
        throw mapApifyError(err, `Reading dataset ${datasetId}`);
      }
    },

    async getRunInput(runId) {
      try {
        const run = await client.run(runId).get();
        const storeId = (run as unknown as RawRun | undefined)?.defaultKeyValueStoreId;
        if (!storeId) return null;
        const record = await client.keyValueStore(storeId).getRecord('INPUT');
        const value = record?.value;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
        return null;
      } catch (err) {
        throw mapApifyError(err, `Fetching input of run ${runId}`);
      }
    },
  };
}
