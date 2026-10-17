/** Capped exponential retry with equal jitter. Units follow the caller's clock. */
export const RETRY = { base: 250, cap: 30_000, exponent: 7, jitter: 0.5 } as const;
export interface RetryPolicy { base: number; cap: number; exponent?: number; jitter?: number; delays?: readonly number[] }
export function backoff(attempt: number, policy: RetryPolicy = RETRY, random = Math.random): number {
  const n = Math.max(0, Math.floor(attempt));
  const ceiling = policy.delays
    ? policy.delays[Math.min(n, policy.delays.length - 1)]!
    : Math.min(policy.cap, policy.base * 2 ** Math.min(n, policy.exponent ?? 30));
  const jitter = policy.jitter ?? RETRY.jitter;
  return ceiling * (1 - jitter + jitter * random());
}
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}
