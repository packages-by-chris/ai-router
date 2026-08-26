/**
 * Redis-backed RouterStateStore for @ai-router/core.
 *
 * Persists the engine's learned routing state (health stats, outcome memory,
 * circuit breakers) as a single JSON snapshot under one key with a TTL.
 * Last-writer-wins per snapshot: replicas converge on fresh-enough data
 * without needing atomic read-modify-write — appropriate for telemetry-grade
 * state, deliberately not for linearizable counters (use RedisStore for
 * rate limits/budgets, which DO need atomicity).
 *
 * Reuses the same bring-your-own-client pattern as RedisStore: adapt any
 * client exposing EVAL with `ioredisClient()` / `nodeRedisClient()`.
 */

import type { RouterStateStore } from "@ai-router/core";
import type { RedisEvalClient } from "./store.js";

export const STATE_GET_SCRIPT = `
return redis.call('GET', KEYS[1])
`;

export const STATE_SET_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`;

export interface RedisStateStoreOptions {
  client: RedisEvalClient;
  /** Key namespace. Default "ai-router:" (state key is appended). */
  prefix?: string;
  /** Called with every client error (wire into your logger/metrics). */
  onError?: (err: unknown) => void;
}

export class RedisStateStore implements RouterStateStore {
  private readonly client: RedisEvalClient;
  private readonly prefix: string;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: RedisStateStoreOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix ?? "ai-router:";
    this.onError = opts.onError;
  }

  async get(key: string): Promise<string | null> {
    try {
      const raw = await this.client.eval(STATE_GET_SCRIPT, [this.prefix + key], []);
      if (typeof raw === "string") return raw;
      if (raw === null || raw === undefined || raw === false) return null;
      // Some clients wrap single-string replies oddly.
      return typeof Buffer !== "undefined" && Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    } catch (err) {
      this.onError?.(err);
      return null; // fail open: losing state degrades to in-process learning
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    try {
      await this.client.eval(STATE_SET_SCRIPT, [this.prefix + key], [value, Math.max(1, Math.floor(ttlMs))]);
    } catch (err) {
      this.onError?.(err);
      // Write loss is acceptable; never surface into routing.
    }
  }
}
