/**
 * Application-recorded outcome memory — the input to quality-aware routing.
 *
 * Applications know quality better than any universal metric: a summarizer
 * can score faithfulness, an agent can score task completion. `recordOutcome`
 * ingests those signals as exponentially-weighted averages keyed by
 * (task, route). Strategies like "quality-first" read them; when no data
 * exists they degrade gracefully to cost/latency ordering.
 *
 * Memory is decaying, not permanent: quality and success EMAs drift toward
 * neutral (0.5) after `halfLifeMs` of silence, so stale verdicts cannot
 * outrank fresh ones forever. Deterministic EMA math only — no opaque ML.
 * `serialize()`/`load()` support cross-restart/cross-replica state sharing.
 */

export interface OutcomeEvent {
  /** Route id the request was served by. */
  routeId: string;
  /** Application task type, e.g. "summarize" or "support-ticket". Optional. */
  task?: string;
  /** Did the application consider the result usable? Default true. */
  success?: boolean;
  /**
   * Application-defined quality in [0,1] (human rating, eval harness,
   * downstream signal — anything). Never invented by the router itself.
   */
  quality?: number;
  latencyMs?: number;
  costUsd?: number;
}

export interface OutcomeStats {
  routeId: string;
  /** Task bucket ("" = untasked). */
  task: string;
  samples: number;
  /** EMA of success flags in [0,1]. */
  successRate: number;
  /** EMA of app-reported quality in [0,1]; undefined until reported. */
  avgQuality?: number;
  avgLatencyMs?: number;
  avgCostUsd?: number;
}

export interface OutcomeTrackerOptions {
  /** Smoothing factor for all EMAs (0 < alpha ≤ 1). Default 0.3. */
  alpha?: number;
  /** Half-life for decay toward neutral after silence in ms. 0 disables decay. */
  halfLifeMs?: number;
}

interface Bucket {
  samples: number;
  successRateEma: number;
  qualityEma?: number;
  latencyEma?: number;
  costEma?: number;
  lastAt: number;
}

const NEUTRAL = 0.5;

function emptyBucket(now: number): Bucket {
  return { samples: 0, successRateEma: 1, lastAt: now };
}

export class OutcomeTracker {
  private readonly buckets = new Map<string, Bucket>();
  private readonly alpha: number;
  private readonly halfLifeMs: number;

  constructor(opts: OutcomeTrackerOptions = {}) {
    this.alpha = Math.min(1, Math.max(0.001, opts.alpha ?? ALPHA_DEFAULT));
    this.halfLifeMs = opts.halfLifeMs ?? HALF_LIFE_DEFAULT;
  }

  record(event: OutcomeEvent): void {
    if (!/^[a-z0-9_.-]*$/i.test(event.routeId)) return; // defensive: never throw on telemetry
    if (event.quality !== undefined && !(event.quality >= 0 && event.quality <= 1)) return;
    const now = Date.now();
    const key = `${event.task ?? ""}|${event.routeId}`;
    const b = this.buckets.get(key) ?? emptyBucket(now);
    this.decay(b, now);
    b.samples++;
    b.successRateEma = ema(b.successRateEma, event.success === false ? 0 : 1, this.alpha);
    if (event.quality !== undefined) b.qualityEma = ema(b.qualityEma, event.quality, this.alpha);
    if (event.latencyMs !== undefined) b.latencyEma = ema(b.latencyEma, event.latencyMs, this.alpha);
    if (event.costUsd !== undefined) b.costEma = ema(b.costEma, event.costUsd, this.alpha);
    b.lastAt = now;
    this.buckets.set(key, b);
  }

  /** Observed quality EMA for a (task, route) pair; undefined without data. */
  quality(task: string | undefined, routeId: string): number | undefined {
    const b = this.buckets.get(`${task ?? ""}|${routeId}`);
    if (!b || b.qualityEma === undefined) return undefined;
    return this.decayed(b, Date.now())?.qualityEma;
  }

  snapshot(): OutcomeStats[] {
    const now = Date.now();
    const out: OutcomeStats[] = [];
    for (const [key, raw] of this.buckets) {
      const sep = key.indexOf("|");
      const task = key.slice(0, sep);
      const routeId = key.slice(sep + 1);
      const b = this.decayed(raw, now)!;
      out.push({
        routeId,
        task,
        samples: b.samples,
        successRate: round6(b.successRateEma),
        ...(b.qualityEma !== undefined ? { avgQuality: round6(b.qualityEma) } : {}),
        ...(b.latencyEma !== undefined ? { avgLatencyMs: round6(b.latencyEma) } : {}),
        ...(b.costEma !== undefined ? { avgCostUsd: round6(b.costEma) } : {}),
      });
    }
    return out;
  }

  // ------------------------------------------------------------- persistence

  serialize(now = Date.now()): unknown {
    const buckets: Array<[string, unknown]> = [];
    for (const [key, b] of this.buckets) {
      buckets.push([
        key,
        {
          samples: b.samples,
          successRateEma: b.successRateEma,
          qualityEma: b.qualityEma,
          latencyEma: b.latencyEma,
          costEma: b.costEma,
          lastAt: b.lastAt,
        },
      ]);
    }
    return { v: 1, savedAt: now, alpha: this.alpha, halfLifeMs: this.halfLifeMs, buckets };
  }

  load(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const d = data as { v?: number; buckets?: unknown };
    if (d.v !== 1 || !Array.isArray(d.buckets)) return false;
    try {
      for (const entry of d.buckets as Array<[string, Record<string, unknown>]>) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const r = entry[1];
        if (typeof r !== "object" || r === null) continue;
        const b: Bucket = {
          samples: numOr(r.samples, 0),
          successRateEma: clamp01(numOr(r.successRateEma, 1)),
          qualityEma: r.qualityEma === undefined || r.qualityEma === null ? undefined : clamp01(numOr(r.qualityEma, NEUTRAL)),
          latencyEma: numOrU(r.latencyEma),
          costEma: numOrU(r.costEma),
          lastAt: numOr(r.lastAt, Date.now()),
        };
        this.buckets.set(entry[0], b);
      }
      return true;
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------------- internals

  private decay(b: Bucket, now: number): void {
    if (this.halfLifeMs <= 0) return;
    const elapsed = now - b.lastAt;
    if (elapsed <= 0) return;
    const d = Math.pow(0.5, elapsed / this.halfLifeMs);
    // Success rate decays toward 50/50; quality toward neutral 0.5.
    b.successRateEma = NEUTRAL + (b.successRateEma - NEUTRAL) * d;
    if (b.qualityEma !== undefined) b.qualityEma = NEUTRAL + (b.qualityEma - NEUTRAL) * d;
  }

  private decayed(b: Bucket, now: number): Bucket | undefined {
    const copy: Bucket = { ...b };
    this.decay(copy, now);
    return copy;
  }
}

// ------------------------------------------------------------------ helpers

const ALPHA_DEFAULT = 0.3;
const HALF_LIFE_DEFAULT = 30 * 60_000;

function ema(prev: number | undefined, value: number, alpha: number): number {
  return prev === undefined ? value : prev * (1 - alpha) + value * alpha;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numOrU(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
