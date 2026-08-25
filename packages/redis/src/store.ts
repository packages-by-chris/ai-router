/**
 * Redis-backed RateLimitStore for @ai-router/core.
 *
 * Sliding-window log per key, stored as a ZSET:
 *   member = "<nowMs>:<seq>:<rand>:<cost>"   (cost anchored last)
 *   score  = nowMs
 * One Lua script per operation keeps check-and-consume atomic across
 * replicas — the whole point of this store (per-process MemoryStore
 * undercounts by the replica count).
 *
 * No hard dependency on any Redis client. Bring your own and adapt it with
 * `ioredisClient()` or `nodeRedisClient()`, or implement the two-method
 * `RedisEvalClient` surface for anything else (Upstash, cluster wrappers).
 */

import type { RateLimitDecision, RateLimitStore } from "@ai-router/core";

/** Minimal client surface: EVAL with keys/args split. */
export interface RedisEvalClient {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}

/** Adapter for ioredis: client.eval(script, numKeys, ...keys, ...args). */
export function ioredisClient(client: {
  eval(script: string, numKeys: number, ...keysAndArgs: unknown[]): Promise<unknown>;
}): RedisEvalClient {
  return {
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
  };
}

/** Adapter for node-redis v4+: client.eval(script, { keys, arguments }). */
export function nodeRedisClient(client: {
  eval(
    script: string,
    options: { keys: string[]; arguments: unknown[] },
  ): Promise<unknown>;
}): RedisEvalClient {
  return {
    eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
  };
}

export const TAKE_SCRIPT = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local member = ARGV[5]
local cutoff = now - window_ms
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local entries = redis.call('ZRANGE', key, 0, -1)
local used = 0
for i = 1, #entries do
  local c = tonumber(string.match(entries[i], ':(%d+)$'))
  if c then used = used + c end
end
if used + cost <= limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window_ms)
  return {1, 0}
end
local retry = 1
if #entries > 0 then
  local oldest = string.match(entries[1], '^(%d+):')
  if oldest then retry = math.max(1, tonumber(oldest) + window_ms - now) end
end
return {0, retry}
`;

export const RECORD_SCRIPT = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window_ms)
return 1
`;

export const USED_SCRIPT = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)
local entries = redis.call('ZRANGE', key, 0, -1)
local used = 0
for i = 1, #entries do
  local c = tonumber(string.match(entries[i], ':(%d+)$'))
  if c then used = used + c end
end
return used
`;

export interface RedisStoreOptions {
  /** Any client adapted to RedisEvalClient (see ioredisClient / nodeRedisClient). */
  client: RedisEvalClient;
  /** Key namespace. Default "ai-router:". */
  prefix?: string;
  /**
   * Redis failure behavior. true (default): allow the request and keep
   * routing — the limiter is a guard, not the product. false: block while
   * Redis is unreachable (strict budget enforcement).
   */
  failOpen?: boolean;
  /** Called with every client error (wire into your logger/metrics). */
  onError?: (err: unknown) => void;
  /** Clock injection for tests. Default Date.now. */
  now?: () => number;
}

function parsePair(raw: unknown): RateLimitDecision {
  if (Array.isArray(raw) && raw.length >= 2) {
    const allowed = Number(raw[0]) === 1;
    const retryAfterMs = Math.max(0, Number(raw[1]) || 0);
    return { allowed, retryAfterMs };
  }
  // Defensive: some clients/pipelines flatten Lua returns oddly.
  return { allowed: raw === 1 || raw === "1", retryAfterMs: 0 };
}

export class RedisStore implements RateLimitStore {
  private readonly client: RedisEvalClient;
  private readonly prefix: string;
  private readonly failOpen: boolean;
  private readonly onError?: (err: unknown) => void;
  private readonly now: () => number;
  private seq = 0;

  constructor(opts: RedisStoreOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix ?? "ai-router:";
    this.failOpen = opts.failOpen ?? true;
    this.onError = opts.onError;
    this.now = opts.now ?? Date.now;
  }

  async take(key: string, cost: number, windowMs: number, limit: number): Promise<RateLimitDecision> {
    try {
      const raw = await this.client.eval(TAKE_SCRIPT, [this.prefix + key], [
        cost,
        windowMs,
        limit,
        this.now(),
        this.member(cost),
      ]);
      return parsePair(raw);
    } catch (err) {
      return this.handleFailure(err);
    }
  }

  async record(key: string, cost: number, windowMs: number): Promise<void> {
    try {
      await this.client.eval(RECORD_SCRIPT, [this.prefix + key], [
        cost,
        windowMs,
        this.now(),
        this.member(cost),
      ]);
    } catch (err) {
      // Post-hoc accounting loss is acceptable in fail-open mode; surface it.
      this.onError?.(err);
      if (!this.failOpen) throw err;
    }
  }

  async used(key: string, windowMs: number): Promise<number> {
    try {
      const raw = await this.client.eval(USED_SCRIPT, [this.prefix + key], [
        windowMs,
        this.now(),
      ]);
      return Math.max(0, Number(raw) || 0);
    } catch (err) {
      // Budget checks fail open like everything else in this store.
      this.onError?.(err);
      return 0;
    }
  }

  private handleFailure(err: unknown): RateLimitDecision {
    this.onError?.(err);
    if (this.failOpen) return { allowed: true, retryAfterMs: 0 };
    return { allowed: false, retryAfterMs: 0 };
  }

  /** Uniqueness matters: ZADD overwrites duplicate members silently. */
  private member(cost: number): string {
    this.seq = (this.seq + 1) % Number.MAX_SAFE_INTEGER;
    const rand = Math.random().toString(36).slice(2, 10);
    return `${this.now()}:${this.seq}:${rand}:${cost}`;
  }
}
