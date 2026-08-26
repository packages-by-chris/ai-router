/**
 * Offline strategy replay: "what would strategy X have picked?" over a
 * recorded event log, without touching providers.
 *
 * Feed it requests plus their observed outcomes (serving route, success,
 * quality, latency, cost) and it walks the log through FRESH trackers using
 * the exact same pure ordering code (`arrangeChain`) the live engine runs —
 * so replay results match runtime behavior, including decay, per-op latency
 * statistics, shrinkage, and configured weights.
 *
 * Gates (capabilities, budgets, circuit breakers) are intentionally NOT
 * simulated: replay answers ordering questions, not admission questions.
 * Use the failure simulator for recovery-path scenarios.
 */

import type { RouterConfig } from "../config/schema.js";
import { estimateTokens } from "../engine.js";
import type { NormalizedRoute } from "../providers/types.js";
import {
  DEFAULT_HALF_LIFE_MS,
  DEFAULT_SAMPLE_TTL_MS,
  HealthTracker,
  type RouteHealthSnapshot,
  type RouteOpStat,
} from "./health.js";
import { OutcomeTracker } from "./outcomes.js";
import { arrangeChain } from "./order.js";

/** Minimal request shape ordering decisions read (`model`, messages, params). */
export interface ReplayRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<unknown>;
  max_tokens?: number;
  [key: string]: unknown;
}

/** One recorded request + its observed outcome. */
export interface ReplayEvent {
  request: ReplayRequest;
  /** Route id that actually served it. Defaults to the strategy's first pick. */
  servedRouteId?: string;
  success?: boolean;
  quality?: number;
  latencyMs?: number;
  costUsd?: number;
  /** Which latency statistic learns from this event. Default "complete". */
  op?: RouteOpStat;
}

export interface ReplayOptions {
  rng?: () => number;
  halfLifeMs?: number;
  sampleTtlMs?: number;
  emaAlpha?: number;
}

export interface ReplayResult {
  /** Strategy's chosen route id per event (first candidate after ordering). */
  chosen: string[];
  /** Full candidate order per event. */
  orders: string[][];
  /** Health tracker state after replaying all events. */
  health: RouteHealthSnapshot[];
  /** Outcome memory after replaying all events. */
  outcomes: ReturnType<OutcomeTracker["snapshot"]>;
}

/**
 * Replays `events` through `strategy`, learning from each recorded outcome,
 * and reports what the router would have chosen at every step.
 */
export function replayStrategy(
  config: Pick<RouterConfig, "routes" | "weights">,
  strategy: RouterConfig["strategy"],
  events: ReplayEvent[],
  opts: ReplayOptions = {},
): ReplayResult {
  const halfLifeMs = opts.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const health = new HealthTracker({
    halfLifeMs,
    sampleTtlMs: opts.sampleTtlMs ?? DEFAULT_SAMPLE_TTL_MS,
  });
  const outcomes = new OutcomeTracker({ alpha: opts.emaAlpha ?? 0.3, halfLifeMs });
  const rng = opts.rng ?? Math.random;
  let rrCounter = 0;

  const chosen: string[] = [];
  const orders: string[][] = [];

  for (const event of events) {
    const index = config.routes.findIndex((r) => r.id === event.request.model);
    if (index === -1) {
      chosen.push("");
      orders.push([]);
      continue;
    }
    // Ordering only reads id/weight — raw config routes suffice.
    const chain = config.routes.slice(index).map((r) => r as unknown as NormalizedRoute);
    const counter = strategy === "round-robin" && chain.length > 1 ? rrCounter++ : 0;
    const result = arrangeChain({
      strategy,
      op: event.op ?? "complete",
      task: undefined,
      rng,
      rrCounter: counter,
      health,
      outcomes,
      estimateTokensFn: estimateTokens,
      weights: config.weights,
      req: event.request as Parameters<typeof estimateTokens>[0] & ReplayRequest,
      chain,
    });

    const orderIds = result.chain.map((r) => r.id);
    orders.push(orderIds);
    chosen.push(orderIds[0] ?? "");

    // Learn from the recorded outcome so subsequent decisions reflect it.
    const servedId = event.servedRouteId ?? orderIds[0];
    if (!servedId) continue;
    if (event.quality !== undefined || event.success !== undefined || event.costUsd !== undefined) {
      outcomes.record({
        routeId: servedId,
        ...(event.quality !== undefined ? { quality: event.quality } : {}),
        ...(event.success !== undefined ? { success: event.success } : {}),
        ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
      });
    }
    if (event.latencyMs !== undefined) {
      const op = event.op ?? "complete";
      if (event.success === false) {
        // Recorded failures count as slow-path evidence (timeout class).
        health.recordFailure(servedId, "timeout", { latencyMs: event.latencyMs, op });
      } else if (op === "stream") {
        health.recordSuccess(servedId, { op, ttfbMs: event.latencyMs });
      } else {
        health.recordSuccess(servedId, { op, latencyMs: event.latencyMs });
      }
    }
  }

  return { chosen, orders, health: health.snapshot(), outcomes: outcomes.snapshot() };
}
