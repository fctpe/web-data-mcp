const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class WebDataError extends Error {
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(message: string, opts: { retryable?: boolean; statusCode?: number } = {}) {
    super(message);
    this.name = 'WebDataError';
    this.retryable = opts.retryable ?? false;
    this.statusCode = opts.statusCode;
  }
}

interface ApifyApiErrorLike {
  statusCode?: number;
  type?: string;
  message?: string;
}

function isApiErrorLike(err: unknown): err is ApifyApiErrorLike {
  return typeof err === 'object' && err !== null && ('statusCode' in err || 'message' in err);
}

/**
 * Maps upstream Apify API failures to messages an agent can act on.
 * The APIFY_TOKEN value must never appear in any message.
 */
export function mapApifyError(err: unknown, context: string): WebDataError {
  if (err instanceof WebDataError) return err;

  if (isApiErrorLike(err)) {
    const status = err.statusCode;
    const retryable = status !== undefined && RETRYABLE_STATUS.has(status);
    switch (status) {
      case 401:
        return new WebDataError(
          `${context}: Apify rejected the API token (401). Check that APIFY_TOKEN is set to a valid token.`,
          { statusCode: status },
        );
      case 402:
        return new WebDataError(
          `${context}: Apify account has insufficient credit or a payment issue (402).`,
          { statusCode: status },
        );
      case 403:
        return new WebDataError(
          `${context}: access denied by Apify (403). The token may lack permission for this resource.`,
          { statusCode: status },
        );
      case 404:
        return new WebDataError(
          `${context}: resource not found on Apify (404). Check the actor/run/dataset id.`,
          { statusCode: status },
        );
      case 429:
        return new WebDataError(
          `${context}: Apify rate limit hit (429). Retry after a short delay.`,
          { statusCode: status, retryable: true },
        );
      default: {
        const detail = err.message ?? 'unknown Apify API error';
        return new WebDataError(`${context}: ${detail}${status ? ` (${status})` : ''}`, {
          retryable,
          ...(status !== undefined && { statusCode: status }),
        });
      }
    }
  }

  const detail = err instanceof Error ? err.message : String(err);
  return new WebDataError(`${context}: ${detail}`);
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}
