/**
 * In-process route health tracking.
 *
 * Granularity: route (provider + model) with per-key-index failure/cooldown
 * overlays — the level at which routing decisions are made. Everything lives
 * in memory on the engine instance; multi-replica deployments each see their
 * own slice (same trade-off as the built-in circuit breaker).
 *
 * Latency samples sit in fixed-size ring buffers so percentile queries
 * (p50/p95/p99) stay bounded and memory stays flat.
 */

import type { ErrorKind } from "../errors.js";

const RING_CAPACITY = 128;
/** Upper bound for key cooldowns derived from provider Retry-After values. */
export const KEY_COOLDOWN_CAP_MS = 5 * 60_000;

export interface KeyHealth {
  keyIndex: number;
  /** Consecutive failures observed while this key was attempted. */
  failures: number;
  /** Ms remaining on this key's rate-limit/auth cooldown (0 = healthy). */
  cooldownRemainingMs: number;
}

export interface RouteHealthSnapshot {
  routeId: string;
  successes: number;
  failures: number;
  /** Failure tallies by classified error kind. */
  byKind: Partial<Record<ErrorKind, number>>;
  /** Success-rate EMA in [0,1]; starts at 1 until data says otherwise. */
  successRate: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  p99LatencyMs?: number;
  /** Time-to-first-chunk percentiles (streams only). */
  p50TtfbMs?: number;
  p95TtfbMs?: number;
  p99TtfbMs?: number;
  keys: KeyHealth[];
}

interface Ring {
  buf: Float64Array;
  size: number;
  head: number;
}

function emptyRing(): Ring {
  return { buf: new Float64Array(RING_CAPACITY), size: 0, head: 0 };
}

function push(ring: Ring, value: number): void {
  ring.buf[ring.head] = value;
  ring.head = (ring.head + 1) % RING_CAPACITY;
  if (ring.size < RING_CAPACITY) ring.size++;
}

function percentile(ring: Ring, p: number): number | undefined {
  if (ring.size === 0) return undefined;
  const sorted = Array.from(ring.buf.subarray(0, ring.size)).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]! * 100) / 100;
}

const EMPTY_RING = emptyRing();

interface RouteState {
  successes: number;
  failures: number;
  byKind: Map<ErrorKind, number>;
  successRateEma: number;
  latency: Ring;
  ttft: Ring;
  keys: Map<number, { failures: number; cooldownUntil: number }>;
}

function emptyState(): RouteState {
  return {
    successes: 0,
    failures: 0,
    byKind: new Map(),
    successRateEma: 1,
    latency: emptyRing(),
    ttft: emptyRing(),
    keys: new Map(),
  };
}

const SUCCESS_EMA_ALPHA = 0.3;

/**
 * Tracks observed per-route performance. All methods are synchronous;
 * hot-path calls (record*) are O(1).
 */
export class HealthTracker {
  private readonly routes = new Map<string, RouteState>();

  recordSuccess(routeId: string, opts: { latencyMs?: number; ttfbMs?: number } = {}): void {
    const s = this.stateFor(routeId);
    s.successes++;
    s.successRateEma += (1 - s.successRateEma) * SUCCESS_EMA_ALPHA;
    if (opts.latencyMs !== undefined) push(s.latency, opts.latencyMs);
    if (opts.ttfbMs !== undefined) push(s.ttft, opts.ttfbMs);
  }

  recordFailure(
    routeId: string,
    kind: ErrorKind,
    opts: { keyIndex?: number; retryAfterMs?: number } = {},
  ): void {
    const s = this.stateFor(routeId);
    s.failures++;
    s.byKind.set(kind, (s.byKind.get(kind) ?? 0) + 1);
    s.successRateEma -= s.successRateEma * SUCCESS_EMA_ALPHA;
    if (opts.keyIndex === undefined) return;
    const key = this.keyState(s, opts.keyIndex);
    key.failures++;
    // Rate-limit / auth / permission responses carrying Retry-After put the
    // key on a short vacation so subsequent requests skip straight to
    // healthy keys instead of burning an attempt.
    if (
      opts.retryAfterMs !== undefined &&
      (kind === "rate_limit" || kind === "auth" || kind === "permission")
    ) {
      key.cooldownUntil = Date.now() + Math.min(opts.retryAfterMs, KEY_COOLDOWN_CAP_MS);
    }
  }

  /**
   * First key index >= start (mod poolSize) not on cooldown, or null when
   * every index is cooling. Advisory only: callers decide fallback behavior.
   */
  pickKey(routeId: string, start: number, poolSize: number): number | null {
    const s = this.routes.get(routeId);
    const now = Date.now();
    for (let i = 0; i < poolSize; i++) {
      const idx = (start + i) % poolSize;
      const key = s?.keys.get(idx);
      if (!key || now >= key.cooldownUntil) return idx;
    }
    return null;
  }

  keyOnCooldown(routeId: string, keyIndex: number): boolean {
    const key = this.routes.get(routeId)?.keys.get(keyIndex);
    return key !== undefined && key.cooldownUntil !== 0 && Date.now() < key.cooldownUntil;
  }

  /** Median observed total latency (ms), undefined when unobserved. */
  medianLatency(routeId: string): number | undefined {
    return percentile(this.routes.get(routeId)?.latency ?? EMPTY_RING, 0.5);
  }

  snapshot(): RouteHealthSnapshot[] {
    const out: RouteHealthSnapshot[] = [];
    for (const [routeId, s] of this.routes) {
      const byKind: Partial<Record<ErrorKind, number>> = {};
      for (const [k, n] of s.byKind) byKind[k] = n;
      const now = Date.now();
      const keys: KeyHealth[] = [...s.keys.entries()].map(([keyIndex, v]) => ({
        keyIndex,
        failures: v.failures,
        cooldownRemainingMs: v.cooldownUntil > now ? v.cooldownUntil - now : 0,
      }));
      const p50 = percentile(s.latency, 0.5);
      const p95 = percentile(s.latency, 0.95);
      const p99 = percentile(s.latency, 0.99);
      const t50 = percentile(s.ttft, 0.5);
      const t95 = percentile(s.ttft, 0.95);
      const t99 = percentile(s.ttft, 0.99);
      out.push({
        routeId,
        successes: s.successes,
        failures: s.failures,
        byKind,
        successRate: Math.round(s.successRateEma * 10000) / 10000,
        ...(p50 !== undefined ? { p50LatencyMs: p50 } : {}),
        ...(p95 !== undefined ? { p95LatencyMs: p95 } : {}),
        ...(p99 !== undefined ? { p99LatencyMs: p99 } : {}),
        ...(t50 !== undefined ? { p50TtfbMs: t50 } : {}),
        ...(t95 !== undefined ? { p95TtfbMs: t95 } : {}),
        ...(t99 !== undefined ? { p99TtfbMs: t99 } : {}),
        keys,
      });
    }
    return out;
  }

  private stateFor(routeId: string): RouteState {
    let s = this.routes.get(routeId);
    if (!s) {
      s = emptyState();
      this.routes.set(routeId, s);
    }
    return s;
  }

  private keyState(s: RouteState, keyIndex: number): { failures: number; cooldownUntil: number } {
    let k = s.keys.get(keyIndex);
    if (!k) {
      k = { failures: 0, cooldownUntil: 0 };
      s.keys.set(keyIndex, k);
    }
    return k;
  }
}
