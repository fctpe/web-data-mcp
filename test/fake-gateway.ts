import type { ApifyGateway, RunInfo, RunStatus } from '../src/core/apify.js';

export interface CallRecord {
  actorId: string;
  input: Record<string, unknown>;
}

export type Scenario = (
  actorId: string,
  input: Record<string, unknown>,
  callNumber: number,
) => { status?: RunStatus; items: unknown[] };

/**
 * In-memory stand-in for the Apify API. Each actor call mints a run and a
 * dataset whose items come from the scenario callback, so tests can model
 * degraded-then-recovered scrapes without any network access.
 */
export class FakeGateway implements ApifyGateway {
  readonly calls: CallRecord[] = [];
  private readonly runs = new Map<string, RunInfo>();
  private readonly datasets = new Map<string, unknown[]>();
  private readonly inputs = new Map<string, Record<string, unknown>>();
  private counter = 0;

  constructor(private readonly scenario: Scenario) {}

  seedRun(items: unknown[], input: Record<string, unknown>, actorId: string): RunInfo {
    const run = this.mint(actorId, 'SUCCEEDED', items);
    this.inputs.set(run.runId, input);
    return run;
  }

  private mint(actorId: string, status: RunStatus, items: unknown[]): RunInfo {
    this.counter++;
    const runId = `run-${this.counter}`;
    const datasetId = `dataset-${this.counter}`;
    this.datasets.set(datasetId, items);
    const run: RunInfo = {
      runId,
      actorId,
      status,
      datasetId,
      keyValueStoreId: `kvs-${this.counter}`,
      startedAt: '2026-07-12T00:00:00.000Z',
      finishedAt: status === 'RUNNING' ? null : '2026-07-12T00:01:00.000Z',
      statusMessage: null,
    };
    this.runs.set(runId, run);
    return run;
  }

  async callActor(actorId: string, input: Record<string, unknown>): Promise<RunInfo> {
    this.calls.push({ actorId, input });
    const { status = 'SUCCEEDED', items } = this.scenario(actorId, input, this.calls.length);
    const run = this.mint(actorId, status, items);
    this.inputs.set(run.runId, input);
    return run;
  }

  async startActor(actorId: string, input: Record<string, unknown>): Promise<RunInfo> {
    this.calls.push({ actorId, input });
    const run = this.mint(actorId, 'RUNNING', []);
    this.inputs.set(run.runId, input);
    return run;
  }

  async getRun(runId: string): Promise<RunInfo | null> {
    return this.runs.get(runId) ?? null;
  }

  async listDatasetItems(
    datasetId: string,
    opts: { offset?: number; limit?: number; fields?: string[] },
  ): Promise<{ items: unknown[]; total: number; offset: number; count: number }> {
    const all = this.datasets.get(datasetId) ?? [];
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 100;
    const slice = all.slice(offset, offset + limit);
    const items = opts.fields
      ? slice.map((item) => {
          if (typeof item !== 'object' || item === null) return item;
          return Object.fromEntries(
            Object.entries(item as Record<string, unknown>).filter(([key]) =>
              opts.fields?.includes(key),
            ),
          );
        })
      : slice;
    return { items, total: all.length, offset, count: slice.length };
  }

  async getRunInput(runId: string): Promise<Record<string, unknown> | null> {
    return this.inputs.get(runId) ?? null;
  }
}

export const GOOD_PAGE = {
  url: 'https://example.com/pricing',
  text: 'Example Corp pricing starts at 29 euros per month for the starter plan and includes support.',
  markdown:
    '# Pricing\n\nExample Corp pricing starts at 29 euros per month for the starter plan and includes support.',
};

export const BLOCKED_PAGE = {
  url: 'https://example.com/pricing',
  text: 'Access Denied',
};
