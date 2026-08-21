import type { RateLimitDecision, RateLimitStore } from "./store.js";

interface Entry {
  ts: number;
  cost: number;
}

/**
 * Sliding-window log, in-process. Entries are [timestamp, cost] pairs;
 * the window cost is the sum of entries newer than windowMs.
 */
export class MemoryStore implements RateLimitStore {
  private readonly entries = new Map<string, Entry[]>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  async take(key: string, cost: number, windowMs: number, limit: number): Promise<RateLimitDecision> {
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
    const list = this.prune(key, windowMs);
    list.push({ ts: this.now(), cost });
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
