import { describe, expect, it } from 'vitest';
import { WebDataError } from '../src/core/errors.js';
import { withRetry } from '../src/core/retry.js';

describe('withRetry', () => {
  it('returns on first success', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries retryable errors until success', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new WebDataError('rate limited', { retryable: true, statusCode: 429 });
        return 'recovered';
      },
      { attempts: 3, baseDelayMs: 1 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new WebDataError('not found', { statusCode: 404 });
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('not found');
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new WebDataError('upstream down', { retryable: true, statusCode: 503 });
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('upstream down');
    expect(calls).toBe(3);
  });
});
