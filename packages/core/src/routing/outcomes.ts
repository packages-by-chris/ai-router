/**
 * Application-recorded outcome memory — the foundation for adaptive routing.
 *
 * Applications know quality better than any universal metric: a summarizer
 * can score faithfulness, an agent can score task completion. `recordOutcome`
 * ingests those signals as exponentially-weighted averages keyed by
 * (task, route). Strategies like "quality-first" read them; when no data
 * exists they degrade gracefully to cost/latency ordering.
 *
 * Deterministic EMA math only — no opaque ML.
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

const ALPHA = 0.3;

interface Bucket {
  samples: number;
  successRateEma: number;
  qualityEma?: number;
  latencyEma?: number;
  costEma?: number;
}

function emptyBucket(): Bucket {
  return { samples: 0, successRateEma: 1 };
}

function ema(prev: number | undefined, value: number): number {
  return prev === undefined ? value : prev * (1 - ALPHA) + value * ALPHA;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export class OutcomeTracker {
  private readonly buckets = new Map<string, Bucket>();

  record(event: OutcomeEvent): void {
    if (!/^[a-z0-9_.-]*$/i.test(event.routeId)) return; // defensive: never throw on telemetry
    if (event.quality !== undefined && !(event.quality >= 0 && event.quality <= 1)) return;
    const key = `${event.task ?? ""}|${event.routeId}`;
    const b = this.buckets.get(key) ?? emptyBucket();
    b.samples++;
    b.successRateEma = ema(b.successRateEma, event.success === false ? 0 : 1);
    if (event.quality !== undefined) b.qualityEma = ema(b.qualityEma, event.quality);
    if (event.latencyMs !== undefined) b.latencyEma = ema(b.latencyEma, event.latencyMs);
    if (event.costUsd !== undefined) b.costEma = ema(b.costEma, event.costUsd);
    this.buckets.set(key, b);
  }

  /** Observed quality EMA for a (task, route) pair; undefined without data. */
  quality(task: string | undefined, routeId: string): number | undefined {
    return this.buckets.get(`${task ?? ""}|${routeId}`)?.qualityEma;
  }

  snapshot(): OutcomeStats[] {
    const out: OutcomeStats[] = [];
    for (const [key, b] of this.buckets) {
      const sep = key.indexOf("|");
      const task = key.slice(0, sep);
      const routeId = key.slice(sep + 1);
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
}
