import type { ApifyGateway, RunInfo, RunStatus } from '../src/core/apify.js';
import { WebDataError } from '../src/core/errors.js';

export interface CallRecord {
  actorId: string;
  input: Record<string, unknown>;
}

export type Scenario = (
  actorId: string,
  input: Record<string, unknown>,
  callNumber: number,
) => { status?: RunStatus; items: unknown[]; error?: string };

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
    const { status = 'SUCCEEDED', items, error } = this.scenario(actorId, input, this.calls.length);
    if (error) throw new WebDataError(error, { statusCode: 403 });
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

/**
 * A realistic bot wall, and the reason it is realistic matters.
 *
 * This used to be the 13-character string 'Access Denied'. That failed
 * PAGE_SCHEMA's `minLength: 50` on `text`, so schemaPassRate went to 0 and the
 * batch scored ~0.30 — the escalation test passed, but for a reason that had
 * nothing to do with block detection. A real Cloudflare interstitial is several
 * hundred characters of prose with a url, so it passes the schema, looks
 * complete, is not a duplicate, and used to score 0.85: above the retry
 * threshold, escalation never triggered. The fixture was hiding the defect it
 * was supposed to cover.
 *
 * Kept long enough to clear the schema on purpose. If someone shortens it, the
 * assertions in test/blocked-content.test.ts stop testing block detection and
 * start testing `minLength` again — which is why that file asserts the length.
 */
export const BLOCKED_PAGE = {
  url: 'https://example.com/pricing',
  title: 'Attention Required! | Cloudflare',
  text:
    'Attention Required! Please enable cookies. Sorry, you have been blocked. ' +
    'You are unable to access example.com. Why have I been blocked? This website ' +
    'is using a security service to protect itself from online attacks. The action ' +
    'you just performed triggered the security solution. There are several actions ' +
    'that could trigger this block including submitting a certain word or phrase, a ' +
    'SQL command or malformed data. What can I do to resolve this? You can email the ' +
    'site owner to let them know you were blocked. Please include what you were doing ' +
    'when this page came up and the Cloudflare Ray ID found at the bottom of this page.',
  markdown:
    '# Attention Required! | Cloudflare\n\nSorry, you have been blocked. You are unable ' +
    'to access example.com. This website is using a security service to protect itself ' +
    'from online attacks. Please enable cookies and try again, or email the site owner ' +
    'to let them know you were blocked and include the Cloudflare Ray ID from this page.',
};
