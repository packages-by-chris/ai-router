export interface RateLimitDecision {
  allowed: boolean;
  /** When blocked: ms until capacity frees up (best effort). */
  retryAfterMs: number;
}

/**
 * Pluggable rate-limit storage. The default is in-process (MemoryStore);
 * multi-replica deployments inject a Redis/Postgres-backed implementation.
 *
 * `take` = check-and-consume (pre-flight gating).
 * `record` = add usage without gating (post-hoc token/cost accounting).
 * `used` = current window total without consuming (budget pre-flight checks).
 */
export interface RateLimitStore {
  take(key: string, cost: number, windowMs: number, limit: number): Promise<RateLimitDecision>;
  record(key: string, cost: number, windowMs: number): Promise<void>;
  /**
   * Current window usage for a key. Optional: when absent, features that
   * need read-back (spend budgets) fail open (never gate).
   */
  used?(key: string, windowMs: number): Promise<number> | number;
  /**
   * Approximate per-key usage totals for observability (`engine.stats()`).
   * Optional: stores that cannot enumerate keys return nothing here.
   */
  snapshot?(): Promise<Record<string, number>> | Record<string, number>;
}
