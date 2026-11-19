import { platformMetrics } from './metrics';

/**
 * Standard outbound integration call (E14-F01-S01): timeout, bounded retries with exponential
 * back-off and jitter (only for idempotent requests), Retry-After support, a circuit breaker per
 * endpoint, and metrics by integration and outcome.
 */

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  timeoutMs: 10_000,
};

export class CircuitOpenError extends Error {
  constructor(readonly key: string) {
    super(`Circuit is open for ${key}`);
    this.name = 'CircuitOpenError';
  }
}

interface BreakerState {
  failures: number;
  openedAt: number | null;
  probing: boolean;
}

export class CircuitBreaker {
  private readonly states = new Map<string, BreakerState>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly openMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if a request may be attempted. While half-open, only one probe request is allowed. */
  tryAcquire(key: string): boolean {
    const s = this.state(key);
    if (s.openedAt === null) return true;
    if (this.now() - s.openedAt < this.openMs) return false;
    if (s.probing) return false;
    s.probing = true;
    return true;
  }

  recordSuccess(key: string): void {
    this.states.set(key, { failures: 0, openedAt: null, probing: false });
  }

  recordFailure(key: string): void {
    const s = this.state(key);
    s.failures += 1;
    if (s.probing || s.failures >= this.failureThreshold) {
      s.openedAt = this.now();
      s.probing = false;
    }
  }

  isOpen(key: string): boolean {
    const s = this.states.get(key);
    return !!s && s.openedAt !== null && this.now() - s.openedAt < this.openMs;
  }

  private state(key: string): BreakerState {
    let s = this.states.get(key);
    if (!s) {
      s = { failures: 0, openedAt: null, probing: false };
      this.states.set(key, s);
    }
    return s;
  }
}

export interface OutboundOptions {
  /** Integration name for metrics and logs, e.g. `webhook`, `sanctions`, `billing`. */
  integration: string;
  /** Only idempotent requests are retried. */
  idempotent: boolean;
  policy?: Partial<RetryPolicy>;
  breaker?: CircuitBreaker;
  breakerKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2)); // "equal jitter"
}

function retryAfterMs(res: Response, maxMs: number): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(maxMs, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.min(maxMs, Math.max(0, date - Date.now()));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function outboundFetch(
  url: string,
  init: RequestInit,
  opts: OutboundOptions,
): Promise<Response> {
  const policy = { ...DEFAULT_RETRY_POLICY, ...opts.policy };
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const breakerKey = opts.breakerKey ?? new URL(url).origin;
  const m = platformMetrics();
  const maxAttempts = opts.idempotent ? policy.maxAttempts : 1;

  for (let attempt = 1; ; attempt++) {
    if (opts.breaker && !opts.breaker.tryAcquire(breakerKey)) {
      m.integrationCalls.add(1, { integration: opts.integration, outcome: 'circuit_open' });
      throw new CircuitOpenError(breakerKey);
    }
    const started = performance.now();
    let response: Response | undefined;
    let error: unknown;
    try {
      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(policy.timeoutMs)])
        : AbortSignal.timeout(policy.timeoutMs);
      response = await doFetch(url, { ...init, signal });
    } catch (err) {
      error = err;
    }
    const elapsed = performance.now() - started;
    const failed =
      error !== undefined ||
      (response !== undefined && response.status >= 500) ||
      response?.status === 429;
    const outcome = error
      ? 'error'
      : failed
        ? 'retryable_status'
        : response!.ok
          ? 'success'
          : 'client_error';
    m.integrationCalls.add(1, { integration: opts.integration, outcome });
    m.integrationDuration.record(elapsed, { integration: opts.integration, outcome });

    if (opts.breaker) {
      if (failed) opts.breaker.recordFailure(breakerKey);
      else opts.breaker.recordSuccess(breakerKey);
    }

    const retryable =
      error !== undefined || (response !== undefined && isRetryableStatus(response.status));
    if (!retryable || attempt >= maxAttempts) {
      if (error) throw error;
      return response!;
    }
    const wait =
      (response && retryAfterMs(response, policy.maxDelayMs)) ??
      backoffDelay(attempt, policy, opts.random);
    await response?.body?.cancel().catch(() => undefined);
    await sleep(wait);
  }
}
