import type { RateLimitDecision, RateLimitStore } from "./store.js";

interface Entry {
  ts: number;
  cost: number;
}

/**
 * Sliding-window log, in-process. Entries are [timestamp, cost] pairs;
 * the window cost is the sum of entries newer than windowMs.
 *
 * Stale keys are pruned across the entire map every `pruneInterval` calls
 * to prevent unbounded memory growth for rarely-used routes.
 */
export class MemoryStore implements RateLimitStore {
  private readonly entries = new Map<string, Entry[]>();
  private readonly now: () => number;
  private calls = 0;
  private readonly pruneInterval: number;

  constructor(opts: { now?: () => number; pruneInterval?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.pruneInterval = opts.pruneInterval ?? 1000;
  }

  async take(key: string, cost: number, windowMs: number, limit: number): Promise<RateLimitDecision> {
    this.maybePruneAll(windowMs);
    const list = this.prune(key, windowMs);
    const used = list.reduce((sum, e) => sum + e.cost, 0);
    if (used + cost <= limit) {
      list.push({ ts: this.now(), cost });
      return { allowed: true, retryAfterMs: 0 };
    }
    // Time until the oldest entry exits the window.
    const oldest = list[0];
    const retryAfterMs = oldest ? Math.max(1, oldest.ts + windowMs - this.now()) : 1;
    return { allowed: false, retryAfterMs };
  }

  async record(key: string, cost: number, windowMs: number): Promise<void> {
    this.maybePruneAll(windowMs);
    const list = this.prune(key, windowMs);
    list.push({ ts: this.now(), cost });
  }

  /** Sum of retained (non-stale) entries per key. Approximate across mixed windows. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, list] of this.entries) {
      if (list.length === 0) continue;
      out[key] = list.reduce((sum, e) => sum + e.cost, 0);
    }
    return out;
  }

  private maybePruneAll(windowMs: number): void {
    this.calls++;
    if (this.calls < this.pruneInterval) return;
    this.calls = 0;
    const cutoff = this.now() - windowMs;
    for (const [key, list] of this.entries) {
      let drop = 0;
      while (drop < list.length && list[drop]!.ts <= cutoff) drop++;
      if (drop === list.length) {
        this.entries.delete(key);
      } else if (drop > 0) {
        list.splice(0, drop);
      }
    }
  }

  private prune(key: string, windowMs: number): Entry[] {
    let list = this.entries.get(key);
    if (!list) {
      list = [];
      this.entries.set(key, list);
    }
    const cutoff = this.now() - windowMs;
    let drop = 0;
    while (drop < list.length && list[drop]!.ts <= cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
    return list;
  }
}
