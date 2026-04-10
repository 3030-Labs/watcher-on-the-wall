/**
 * Exponential backoff retry wrapper, used primarily for LLM calls and git operations.
 */

export interface RetryOptions {
  retries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  onRetry?: (error: unknown, attempt: number, nextDelayMs: number) => void;
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_OPTS: RetryOptions = {
  retries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
};

/**
 * Retry `fn` with exponential backoff. Rethrows the last error if all attempts fail.
 */
export async function retry<T>(fn: () => Promise<T>, opts: Partial<RetryOptions> = {}): Promise<T> {
  const options: RetryOptions = { ...DEFAULT_OPTS, ...opts };
  let lastError: unknown;
  let delay = options.initialDelayMs;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (options.shouldRetry && !options.shouldRetry(err)) throw err;
      if (attempt === options.retries) break;
      const nextDelay = Math.min(delay, options.maxDelayMs);
      if (options.onRetry) options.onRetry(err, attempt + 1, nextDelay);
      await sleep(nextDelay);
      delay = Math.min(delay * options.factor, options.maxDelayMs);
    }
  }
  throw lastError;
}

/**
 * Promise-based sleep.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
