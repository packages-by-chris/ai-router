/**
 * In-process route health tracking — the routing engine's memory.
 *
 * Granularity: route (provider + model) × operation (complete | stream)
 * with per-key-index failure/cooldown overlays. Latency statistics are
 * timestamped ring buffers whose samples EXPIRE (`sampleTtlMs`), so a route
 * that stops receiving traffic gracefully degrades to "unobserved" instead
 * of ranking on month-old numbers. Success/failure tallies use exponentially
 * DECAYED weighted counts (half-life `halfLifeMs`) feeding a Wilson lower
 * bound — few samples score pessimistically, stale samples fade.
 *
 * Failure handling is kind-aware: only `timeout` and `network` failures push
 * latency samples (they represent genuine slow paths). A fast 500 must not
 * make a broken route look fast.
 *
 * Everything lives in memory on the tracker instance; `serialize()`/
 * `load()` let a RouterStateStore share it across restarts and replicas.
 */

import type { ErrorKind } from "../errors.js";

const RING_CAPACITY = 128;
/** Upper bound for key cooldowns derived from provider Retry-After values. */
export const KEY_COOLDOWN_CAP_MS = 5 * 60_000;

/** Defaults: half-life for count decay, sample freshness window. */
export const DEFAULT_HALF_LIFE_MS = 30 * 60_000;
export const DEFAULT_SAMPLE_TTL_MS = 10 * 60_000;

/** Routing operations tracked separately (different latency semantics). */
export type RouteOpStat = "complete" | "stream";

export interface HealthTrackerOptions {
  /** Count-decay half-life in ms. Stale success/failure evidence fades toward neutral. 0 disables decay. */
  halfLifeMs?: number;
  /** Latency sample freshness in ms. Older samples stop counting. 0 keeps everything. */
  sampleTtlMs?: number;
}

export interface KeyHealth {
  keyIndex: number;
  failures: number;
  cooldownRemainingMs: number;
}

export interface OpLatencyPercentiles {
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  /** Recency-bounded sample count behind these percentiles. */
  samples: number;
}

export interface RouteHealthSnapshot {
  routeId: string;
  successes: number;
  failures: number;
  /** Lifetime failure tallies by classified error kind. */
  byKind: Partial<Record<ErrorKind, number>>;
  /**
   * Decayed success-rate EMA in [0,1]. Starts optimistic (1) and decays
   * toward neutral 0.5 when the route goes quiet (see halfLifeMs).
   */
  successRate: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  p99LatencyMs?: number;
  /** Time-to-first-chunk percentiles (streams only). */
  p50TtfbMs?: number;
  p95TtfbMs?: number;
  p99TtfbMs?: number;
  keys: KeyHealth[];
  /** Wilson lower bound on recent success rate ([0,1]); undefined with no data. */
  successLb?: number;
  /** Decayed timeout share of recent failures [0,1]. */
  timeoutRate?: number;
  /** Per-operation views (op-specific percentiles + recency-bounded samples). */
  complete?: OpLatencyPercentiles & { ttfb?: OpLatencyPercentiles };
  stream?: OpLatencyPercentiles & { ttfb?: OpLatencyPercentiles };
  /**
   * Observed actual-cost / estimate ratio EMA (1 = estimates accurate).
   * Populated when pricing is configured; multiplies future estimates.
   */
  costRatio?: number;
}

interface TimedRing {
  buf: Float64Array;
  ts: Float64Array;
  size: number;
  head: number;
}

function emptyRing(): TimedRing {
  return {
    buf: new Float64Array(RING_CAPACITY),
    ts: new Float64Array(RING_CAPACITY),
    size: 0,
    head: 0,
  };
}

function push(ring: TimedRing, value: number, now: number): void {
  ring.buf[ring.head] = value;
  ring.ts[ring.head] = now;
  ring.head = (ring.head + 1) % RING_CAPACITY;
  if (ring.size < RING_CAPACITY) ring.size++;
}

/** Samples within the TTL window (all of them when ttl === 0). */
function collectWithin(ring: TimedRing, now: number, ttl: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ring.size; i++) {
    const idx = (ring.head - 1 - i + RING_CAPACITY) % RING_CAPACITY;
    if (ttl > 0 && now - ring.ts[idx]! > ttl) break; // older entries are older still
    out.push(ring.buf[idx]!);
  }
  return out;
}

function percentileOf(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]! * 100) / 100;
}

interface OpStat {
  lat: TimedRing;
  ttfb: TimedRing;
}

interface KindTally {
  n: number;
  w: number;
}

interface RouteState {
  successes: number;
  failures: number;
  byKind: Map<ErrorKind, KindTally>;
  successRateEma: number;
  succW: number;
  failW: number;
  succLastAt: number;
  ops: Record<RouteOpStat, OpStat>;
  keys: Map<number, { failures: number; cooldownUntil: number }>;
  costRatioEma?: number;
  costRatioLastAt?: number;
}

function emptyOpStat(): OpStat {
  return { lat: emptyRing(), ttfb: emptyRing() };
}

function emptyState(now: number): RouteState {
  return {
    successes: 0,
    failures: 0,
    byKind: new Map(),
    successRateEma: 1,
    succW: 0,
    failW: 0,
    succLastAt: now,
    ops: { complete: emptyOpStat(), stream: emptyOpStat() },
    keys: new Map(),
  };
}

const SUCCESS_EMA_ALPHA = 0.3;
const WILSON_Z = 1.96;

/** Wilson lower bound at ~95% confidence over (possibly fractional) counts. */
export function wilsonLowerBound(successes: number, total: number): number | undefined {
  if (total <= 0) return undefined;
  const p = successes / total;
  const z2 = WILSON_Z * WILSON_Z;
  const n = total;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, Math.min(1, (centre - spread) / denom));
}

/**
 * Tracks observed per-route performance. All methods are synchronous;
 * hot-path calls (record*) are O(1). Construct with `halfLifeMs`/`sampleTtlMs`
 * to control staleness (sane defaults; 0 disables a mechanism).
 */
export class HealthTracker {
  private readonly routes = new Map<string, RouteState>();
  private readonly halfLifeMs: number;
  private readonly sampleTtlMs: number;

  constructor(opts: HealthTrackerOptions = {}) {
    this.halfLifeMs = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    this.sampleTtlMs = opts.sampleTtlMs ?? DEFAULT_SAMPLE_TTL_MS;
  }

  recordSuccess(
    routeId: string,
    opts: { latencyMs?: number; ttfbMs?: number; op?: RouteOpStat } = {},
  ): void {
    const now = Date.now();
    const s = this.stateFor(routeId, now);
    s.successes++;
    this.decayCounts(s, now);
    s.succW += 1;
    s.successRateEma += (1 - s.successRateEma) * SUCCESS_EMA_ALPHA;
    const op = s.ops[opts.op ?? "complete"];
    if (opts.latencyMs !== undefined) push(op.lat, opts.latencyMs, now);
    if (opts.ttfbMs !== undefined) push(op.ttfb, opts.ttfbMs, now);
  }

  recordFailure(
    routeId: string,
    kind: ErrorKind,
    opts: { keyIndex?: number; retryAfterMs?: number; latencyMs?: number; op?: RouteOpStat } = {},
  ): void {
    const now = Date.now();
    const s = this.stateFor(routeId, now);
    s.failures++;
    this.decayCounts(s, now);
    s.failW += 1;
    const tally = s.byKind.get(kind) ?? { n: 0, w: 0 };
    tally.n += 1;
    tally.w += 1;
    s.byKind.set(kind, tally);
    s.successRateEma -= s.successRateEma * SUCCESS_EMA_ALPHA;
    // Only genuine slow-path failures count as latency evidence. A fast 500
    // would otherwise make a broken route look FAST and win traffic.
    if (
      opts.latencyMs !== undefined &&
      (kind === "timeout" || kind === "network")
    ) {
      push(s.ops[opts.op ?? "complete"].lat, opts.latencyMs, now);
    }
    if (opts.keyIndex === undefined) return;
    const key = this.keyState(s, opts.keyIndex);
    key.failures++;
    if (
      opts.retryAfterMs !== undefined &&
      (kind === "rate_limit" || kind === "auth" || kind === "permission")
    ) {
      key.cooldownUntil = Date.now() + Math.min(opts.retryAfterMs, KEY_COOLDOWN_CAP_MS);
    }
  }

  /** Record an observed actualCost/estimate ratio (>1 = estimates ran low). */
  recordCostRatio(routeId: string, ratio: number): void {
    const now = Date.now();
    const s = this.stateFor(routeId, now);
    const clamped = Math.max(0.01, Math.min(100, ratio));
    this.decayCost(s, now);
    s.costRatioEma = s.costRatioEma === undefined ? clamped : s.costRatioEma * 0.7 + clamped * 0.3;
    s.costRatioLastAt = now;
  }

  costRatio(routeId: string): number | undefined {
    const s = this.routes.get(routeId);
    if (!s || s.costRatioEma === undefined) return undefined;
    return this.decayedCostRatio(s, Date.now());
  }

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

  /** Recent-sample count behind a route's latency rings (both ops merged unless op given). */
  sampleCount(routeId: string, op?: RouteOpStat): number {
    const s = this.routes.get(routeId);
    if (!s) return 0;
    const now = Date.now();
    const rings =
      op === undefined
        ? [s.ops.complete.lat, s.ops.stream.lat]
        : [s.ops[op].lat];
    return rings.reduce((n, r) => n + collectWithin(r, now, this.sampleTtlMs).length, 0);
  }

  /** Median observed latency across the requested op(s); undefined when no fresh samples. */
  medianLatency(routeId: string, op?: RouteOpStat): number | undefined {
    return this.latencyPercentile(routeId, 0.5, op);
  }

  latencyPercentile(routeId: string, p: number, op?: RouteOpStat): number | undefined {
    const s = this.routes.get(routeId);
    if (!s) return undefined;
    const now = Date.now();
    const rings =
      op === undefined ? [s.ops.complete.lat, s.ops.stream.lat] : [s.ops[op].lat];
    const values = rings.flatMap((r) => collectWithin(r, now, this.sampleTtlMs));
    return percentileOf(values, p);
  }

  ttfbPercentile(routeId: string, p: number, op: RouteOpStat = "stream"): number | undefined {
    const s = this.routes.get(routeId);
    if (!s) return undefined;
    const values = collectWithin(s.ops[op].ttfb, Date.now(), this.sampleTtlMs);
    return percentileOf(values, p);
  }

  /**
   * Wilson LOWER bound on recent success rate. Pessimistic under uncertainty:
   * 3/3 scores below 12/13, so a lucky streak cannot outrank proven health.
   */
  successLb(routeId: string): number | undefined {
    const s = this.routes.get(routeId);
    if (!s) return undefined;
    this.decayCounts(s, Date.now());
    return wilsonLowerBound(s.succW, s.succW + s.failW);
  }

  /** Decayed timeout share of failure evidence [0,1]; undefined without failures. */
  timeoutRate(routeId: string): number | undefined {
    const s = this.routes.get(routeId);
    if (!s) return undefined;
    this.decayCounts(s, Date.now());
    if (s.failW <= 0) return undefined;
    const tw = s.byKind.get("timeout")?.w ?? 0;
    return Math.max(0, Math.min(1, tw / s.failW));
  }

  snapshot(): RouteHealthSnapshot[] {
    const out: RouteHealthSnapshot[] = [];
    const now = Date.now();
    for (const [routeId, s] of this.routes) {
      const byKind: Partial<Record<ErrorKind, number>> = {};
      for (const [k, v] of s.byKind) byKind[k] = v.n;
      this.decayCounts(s, now);

      const complete = this.opView(s, "complete", now);
      const stream = this.opView(s, "stream", now);
      const allLat = [
        ...collectWithin(s.ops.complete.lat, now, this.sampleTtlMs),
        ...collectWithin(s.ops.stream.lat, now, this.sampleTtlMs),
      ];
      const allTtfb = [
        ...collectWithin(s.ops.complete.ttfb, now, this.sampleTtlMs),
        ...collectWithin(s.ops.stream.ttfb, now, this.sampleTtlMs),
      ];
      const keys: KeyHealth[] = [...s.keys.entries()].map(([keyIndex, v]) => ({
        keyIndex,
        failures: v.failures,
        cooldownRemainingMs: v.cooldownUntil > now ? v.cooldownUntil - now : 0,
      }));

      const snap: RouteHealthSnapshot = {
        routeId,
        successes: s.successes,
        failures: s.failures,
        byKind,
        successRate: Math.round(s.successRateEma * 10000) / 10000,
        ...(percentileOf(allLat, 0.5) !== undefined
          ? {
              p50LatencyMs: percentileOf(allLat, 0.5)!,
              p95LatencyMs: percentileOf(allLat, 0.95)!,
              p99LatencyMs: percentileOf(allLat, 0.99)!,
            }
          : {}),
        ...(percentileOf(allTtfb, 0.5) !== undefined
          ? {
              p50TtfbMs: percentileOf(allTtfb, 0.5)!,
              p95TtfbMs: percentileOf(allTtfb, 0.95)!,
              p99TtfbMs: percentileOf(allTtfb, 0.99)!,
            }
          : {}),
        keys,
        ...(wilsonLowerBound(s.succW, s.succW + s.failW) !== undefined
          ? { successLb: round4(wilsonLowerBound(s.succW, s.succW + s.failW)!) }
          : {}),
        ...(s.failW > 0 && (s.byKind.get("timeout")?.w ?? 0) > 0
          ? { timeoutRate: round4((s.byKind.get("timeout")!.w) / s.failW) }
          : {}),
        ...(complete !== undefined ? { complete } : {}),
        ...(stream !== undefined ? { stream } : {}),
        ...(s.costRatioEma !== undefined
          ? { costRatio: round4(this.decayedCostRatio(s, now)!) }
          : {}),
      };
      out.push(snap);
    }
    return out;
  }

  // ------------------------------------------------------------- persistence

  serialize(now = Date.now()): unknown {
    const routes: Record<string, unknown> = {};
    for (const [id, s] of this.routes) {
      this.decayCounts(s, now);
      routes[id] = {
        successes: s.successes,
        failures: s.failures,
        succW: s.succW,
        failW: s.failW,
        succLastAt: s.succLastAt,
        successRateEma: s.successRateEma,
        byKindW: [...s.byKind].map(([k, v]) => [k, v.n, v.w]),
        costRatioEma: s.costRatioEma,
        costRatioLastAt: s.costRatioLastAt,
        keys: [...s.keys].map(([idx, v]) => [idx, v.failures, v.cooldownUntil]),
        ops: {
          complete: ringDump(s.ops.complete, now),
          stream: ringDump(s.ops.stream, now),
        },
      };
    }
    return { v: 1, savedAt: now, halfLifeMs: this.halfLifeMs, sampleTtlMs: this.sampleTtlMs, routes };
  }

  load(data: unknown, now = Date.now()): boolean {
    if (typeof data !== "object" || data === null) return false;
    const d = data as { v?: number; routes?: Record<string, unknown> };
    if (d.v !== 1 || typeof d.routes !== "object" || d.routes === null) return false;
    try {
      for (const [id, raw] of Object.entries(d.routes)) {
        const r = raw as Record<string, unknown>;
        const s = this.stateFor(id, now);
        s.succW = numOr(r.succW, 0);
        s.failW = numOr(r.failW, 0);
        s.successes = numOr(r.successes, 0);
        s.failures = numOr(r.failures, 0);
        s.succLastAt = numOr(r.succLastAt, now);
        s.successRateEma = numOr(r.successRateEma, 1);
        if (Array.isArray(r.byKindW)) {
          for (const entry of r.byKindW as Array<[string, number, number]>) {
            if (Array.isArray(entry) && typeof entry[0] === "string") {
              s.byKind.set(entry[0] as ErrorKind, { n: numOr(entry[1], 0), w: numOr(entry[2], 0) });
            }
          }
        }
        if (r.costRatioEma !== undefined && r.costRatioEma !== null) {
          s.costRatioEma = numOr(r.costRatioEma, undefined);
          s.costRatioLastAt = numOr(r.costRatioLastAt, now);
        }
        if (Array.isArray(r.keys)) {
          for (const entry of r.keys as Array<[number, number, number]>) {
            if (typeof entry?.[0] === "number") {
              s.keys.set(entry[0], { failures: numOr(entry[1], 0), cooldownUntil: numOr(entry[2], 0) });
            }
          }
        }
        const ops = r.ops as Record<string, unknown> | undefined;
        if (ops) {
          ringLoad(s.ops.complete, ops.complete, now);
          ringLoad(s.ops.stream, ops.stream, now);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------------- internals

  private opView(s: RouteState, op: RouteOpStat, now: number): (OpLatencyPercentiles & { ttfb?: OpLatencyPercentiles }) | undefined {
    const stat = s.ops[op];
    const latValues = collectWithin(stat.lat, now, this.sampleTtlMs);
    const ttfbValues = collectWithin(stat.ttfb, now, this.sampleTtlMs);
    if (latValues.length === 0 && ttfbValues.length === 0) return undefined;
    const view: OpLatencyPercentiles & { ttfb?: OpLatencyPercentiles } = {
      samples: latValues.length,
      ...(percentileOf(latValues, 0.5) !== undefined
        ? { p50Ms: percentileOf(latValues, 0.5)!, p95Ms: percentileOf(latValues, 0.95)!, p99Ms: percentileOf(latValues, 0.99)! }
        : {}),
    };
    if (ttfbValues.length > 0) {
      view.ttfb = {
        samples: ttfbValues.length,
        ...(percentileOf(ttfbValues, 0.5) !== undefined
          ? { p50Ms: percentileOf(ttfbValues, 0.5)!, p95Ms: percentileOf(ttfbValues, 0.95)!, p99Ms: percentileOf(ttfbValues, 0.99)! }
          : {}),
      };
    }
    return view;
  }

  private stateFor(routeId: string, now: number): RouteState {
    let s = this.routes.get(routeId);
    if (!s) {
      s = emptyState(now);
      this.routes.set(routeId, s);
    }
    return s;
  }

  /** Fade success/failure weighted counts and the display EMA toward neutral. */
  private decayCounts(s: RouteState, now: number): void {
    if (this.halfLifeMs <= 0) return;
    const elapsed = now - s.succLastAt;
    if (elapsed <= 0) return;
    const d = Math.pow(0.5, elapsed / this.halfLifeMs);
    s.succW *= d;
    s.failW *= d;
    for (const v of s.byKind.values()) v.w *= d;
    // Neutral ground for ranking purposes is 50/50, not eternal optimism.
    const neutral = 0.5;
    s.successRateEma = neutral + (s.successRateEma - neutral) * d;
    s.succLastAt = now;
  }

  private decayCost(s: RouteState, now: number): void {
    if (this.halfLifeMs <= 0 || s.costRatioEma === undefined || s.costRatioLastAt === undefined) return;
    const elapsed = now - s.costRatioLastAt;
    if (elapsed <= 0) return;
    const d = Math.pow(0.5, elapsed / this.halfLifeMs);
    s.costRatioEma = 1 + (s.costRatioEma - 1) * d; // neutral ratio = 1
    s.costRatioLastAt = now;
  }

  private decayedCostRatio(s: RouteState, now: number): number | undefined {
    if (s.costRatioEma === undefined) return undefined;
    if (this.halfLifeMs <= 0 || s.costRatioLastAt === undefined) return s.costRatioEma;
    const d = Math.pow(0.5, (now - s.costRatioLastAt) / this.halfLifeMs);
    return 1 + (s.costRatioEma - 1) * d;
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

// ------------------------------------------------------------------ helpers

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function numOr(v: unknown, fallback: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : (fallback as number);
}

/** Dump most recent samples (bounded) for persistence. */
function ringDump(op: OpStat, now: number): { lat: Array<[number, number]>; ttfb: Array<[number, number]> } {
  const dump = (ring: TimedRing): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    const start = Math.max(0, ring.size - 32);
    for (let i = start; i < ring.size; i++) {
      const idx = (ring.head - ring.size + i + RING_CAPACITY) % RING_CAPACITY;
      out.push([ring.buf[idx]!, ring.ts[idx]!]);
    }
    void now;
    return out;
  };
  return { lat: dump(op.lat), ttfb: dump(op.ttfb) };
}

function ringLoad(op: OpStat, raw: unknown, now: number): void {
  if (typeof raw !== "object" || raw === null) return;
  const r = raw as { lat?: unknown; ttfb?: unknown };
  const fill = (ring: TimedRing, entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const e of entries as Array<[number, number]>) {
      if (Array.isArray(e) && typeof e[0] === "number" && typeof e[1] === "number") {
        // Resurrect with original timestamps so TTL semantics survive restarts.
        push(ring, e[0], Math.min(e[1], now));
      }
    }
  };
  fill(op.lat, r.lat);
  fill(op.ttfb, r.ttfb);
}
