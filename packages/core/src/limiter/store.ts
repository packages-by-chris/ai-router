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
 * `record` = add usage without gating (post-hoc token accounting).
 */
export interface RateLimitStore {
  take(key: string, cost: number, windowMs: number, limit: number): Promise<RateLimitDecision>;
  record(key: string, cost: number, windowMs: number): Promise<void>;
  /**
   * Approximate per-key usage totals for observability (`engine.stats()`).
   * Optional: stores that cannot enumerate keys return nothing here.
   */
  snapshot?(): Promise<Record<string, number>> | Record<string, number>;
}
