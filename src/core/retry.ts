import { WebDataError } from './errors.js';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

function isRetryable(err: unknown): boolean {
  return err instanceof WebDataError && err.retryable;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries transient upstream failures (429/5xx/timeouts) with exponential
 * backoff and full jitter. Non-retryable errors propagate immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts) throw err;
      opts.onRetry?.(attempt, err);
      const backoff = Math.min(max, base * 2 ** (attempt - 1));
      await delay(Math.random() * backoff);
    }
  }
  throw lastError;
}
