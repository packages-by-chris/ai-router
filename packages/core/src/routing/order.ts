/**
 * Candidate ordering for all routing strategies, plus the multi-signal
 * scoring model behind cheapest/balanced/quality-first.
 *
 * All signals are deterministic and derived from four sources:
 *   - declared pricing (estimated USD per request, corrected by the route's
 *     observed actual/estimate ratio when available)
 *   - observed health (recency-bounded median latency, Wilson lower-bound
 *     success score, timeout share)
 *   - application-recorded outcome quality ("quality-first")
 *   - configured strategy weights (config.weights; defaults 0.5/0.3/0.2)
 *
 * Missing data degrades gracefully to a neutral 0.5 component so partial
 * configuration never disqualifies candidates.
 */

import type { NormalizedRoute } from "../providers/types.js";
import type { ChatRequest } from "../types.js";
import type { RoutingStrategy } from "../config/schema.js";
import type { TokenPrice } from "../types.js";
import type { RouteHealthSnapshot, RouteOpStat } from "./health.js";
import type { OutcomeTracker } from "./outcomes.js";
import type { HealthTracker } from "./health.js";

/**
 * Estimated pre-flight USD cost given an input-token count and a priced
 * route. Output-token assumption: `maxTokens` when set, else ≈ input tokens.
 */
export function estimateCostUsd(
  price: TokenPrice,
  inputTokens: number,
  maxTokens?: number,
): number {
  const outputTokens = maxTokens ?? inputTokens;
  const usd =
    (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output;
  return Math.round(usd * 1e6) / 1e6;
}

/** Price lookup over a pricing table (route id wins, then provider model). */
export function priceLookup(
  pricing: Record<string, TokenPrice> | undefined,
  routeId: string,
  model: string,
): TokenPrice | undefined {
  return pricing?.[routeId] ?? pricing?.[model];
}

/**
 * Rank values within [0,1]. Direction "asc" maps the smallest known value
 * to 1; "desc" the largest. Unknown values sit at neutral 0.5 EXCEPT that
 * a sole observation outranks absence (data beats ignorance): with exactly
 * one known value it scores 1 and unknowns keep 0.5.
 */
function rankValues(values: Array<number | undefined>, dir: "asc" | "desc"): Array<number> {
  const known = values.filter((v): v is number => v !== undefined);
  if (known.length === 0) return values.map(() => 0.5);
  return values.map((v) => {
    if (v === undefined) return 0.5;
    if (known.length === 1) return 1;
    const better = known.filter((k) => (dir === "asc" ? k < v : k > v)).length;
    return 1 - better / (known.length - 1);
  });
}

/**
 * Shrink latency estimates of THINLY-sampled routes toward the best
 * WELL-SAMPLED candidate (n ≥ shrinkK), so one lucky sample cannot outrank
 * proven performance. When no candidate is well-sampled, values pass
 * through untouched — equally-unreliable numbers must not distort each other.
 */
export function shrinkLatencies(
  values: Array<number | undefined>,
  counts: Array<number | undefined>,
  shrinkK = 3,
): Array<number | undefined> {
  const solid: number[] = [];
  values.forEach((v, i) => {
    if (v !== undefined && (counts[i] ?? 0) >= shrinkK) solid.push(v);
  });
  if (solid.length === 0) return values.slice();
  const anchor = Math.min(...solid);
  return values.map((v, i) => {
    if (v === undefined) return undefined;
    const n = counts[i] ?? 0;
    if (n >= shrinkK || shrinkK <= 0) return v;
    return (n * v + (shrinkK - n) * anchor) / shrinkK;
  });
}

export interface PolicyWeights {
  /** Cost weight. Default 0.5. */
  cost?: number;
  /** Speed weight. Default 0.3. */
  speed?: number;
  /** Reliability/quality weight. Default 0.2. */
  reliability?: number;
}

const TIMEOUT_PENALTY = 0.25;

export interface PolicySignals {
  /** Estimated per-candidate USD cost, already ratio-corrected (undefined = unpriced). */
  estCosts: Array<number | undefined>;
  /** Observed median latencies, already shrunk (undefined = unobserved). */
  latencies: Array<number | undefined>;
  /**
   * Reliability scores in [0,1] — Wilson lower bounds (or success EMAs),
   * optionally already timeout-penalized by the caller (undefined = unobserved).
   */
  successScores?: Array<number | undefined>;
  /** Application-recorded quality EMAs (undefined = unrecorded). */
  qualities?: Array<number | undefined>;
  /** Relative term weights; defaults 0.5 cost / 0.3 speed / 0.2 reliability. */
  weights?: PolicyWeights;
}

export interface ScoreBreakdown {
  cost: number;
  speed: number;
  reliability: number;
  total: number;
}

/**
 * Balanced score per candidate in [0,1]:
 *   wCost·costRank + wSpeed·speedRank + wRel·reliabilityRank
 * Quality replaces reliability when at least one candidate has data.
 */
export function balancedScores(signals: PolicySignals): number[] {
  const w = normalizeWeights(signals.weights);
  const costScore = rankValues(signals.estCosts, "asc");
  // Lower latency is better: ascending ranks.
  const speedScore = rankValues(signals.latencies, "asc");
  const qualityInput = signals.qualities ?? [];
  const anyQuality = qualityInput.some((q) => q !== undefined);
  const reliabilitySource = anyQuality ? qualityInput : (signals.successScores ?? []);
  // When quality data exists, routes WITHOUT quality records sit at neutral
  // rather than dragging the reliability rank with missing values.
  const reliabilityScore = rankValues(reliabilitySource, "desc").map((v, i) =>
    reliabilitySource[i] === undefined && anyQuality ? 0.5 : v,
  );
  return costScore.map(
    (c, i) => w.cost * c + w.speed * speedScore[i]! + w.reliability * reliabilityScore[i]!,
  );
}

function normalizeWeights(w?: PolicyWeights): Required<PolicyWeights> {
  const cost = w?.cost ?? 0.5;
  const speed = w?.speed ?? 0.3;
  const reliability = w?.reliability ?? 0.2;
  const total = cost + speed + reliability;
  if (total <= 0) return { cost: 0.5, speed: 0.3, reliability: 0.2 };
  return { cost: cost / total, speed: speed / total, reliability: reliability / total };
}

/**
 * Stable sort helper: orders indices by score descending; ties keep their
 * original relative order.
 */
export function orderByScore(scores: number[]): number[] {
  return scores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.i);
}

/** Extract median latency from a health snapshot list for one route. */
export function medianLatencyOf(
  healthSnapshots: RouteHealthSnapshot[],
  routeId: string,
): number | undefined {
  return healthSnapshots.find((h) => h.routeId === routeId)?.p50LatencyMs;
}

/** Extract success-rate EMA from a health snapshot list for one route. */
export function successRateOf(
  healthSnapshots: RouteHealthSnapshot[],
  routeId: string,
): number | undefined {
  const h = healthSnapshots.find((x) => x.routeId === routeId);
  // A route with zero observations carries no signal.
  if (!h || h.successes + h.failures === 0) return undefined;
  return h.successRate;
}

// --------------------------------------------------------------- arrangeChain

export interface ArrangeContext {
  strategy: RoutingStrategy | undefined;
  /** Operation whose latency statistic drives least-latency ordering. */
  op: RouteOpStat;
  task?: string;
  rng: () => number;
  /** Current round-robin counter (engine-owned; replay owns its own). */
  rrCounter: number;
  health: HealthTracker;
  outcomes: OutcomeTracker;
  estimateTokensFn: (req: Pick<ChatRequest, "messages" | "tools">) => number;
  pricing?: Record<string, TokenPrice>;
  weights?: PolicyWeights;
  req: ChatRequest;
  chain: NormalizedRoute[];
}

export interface ArrangeResult {
  chain: NormalizedRoute[];
  /** Populated for scored strategies: per-candidate breakdown aligned to the OUTPUT order. */
  breakdowns?: Array<ScoreBreakdown | undefined>;
  /** True when exploration promoted a non-primary candidate this call. */
  explored?: boolean;
}

/**
 * Pure strategy ordering shared by the live engine and the offline replay
 * harness: reorders the candidate slice according to the strategy. Never
 * removes candidates. Exploration is NOT applied here — callers layer it on
 * top so they can log/control it.
 */
export function arrangeChain(ctx: ArrangeContext): ArrangeResult {
  const chain = ctx.chain;
  if (chain.length <= 1) return { chain };

  if (ctx.strategy === "round-robin") {
    const offset = ctx.rrCounter % chain.length;
    if (offset > 0) chain.push(...chain.splice(0, offset));
    return { chain };
  }

  if (ctx.strategy === "weighted") {
    const weights = chain.map((r) => (r.weight && r.weight > 0 ? r.weight : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let pick = ctx.rng() * total;
    let offset = 0;
    for (let i = 0; i < weights.length; i++) {
      pick -= weights[i]!;
      if (pick <= 0) {
        offset = i;
        break;
      }
    }
    if (offset > 0) chain.push(...chain.splice(0, offset));
    return { chain };
  }

  if (ctx.strategy === "least-latency") {
    // Fastest-first by recent p50 for THIS op. Unobserved routes sort BEFORE
    // observed ones (bounded cold-start sampling) keeping config order among
    // themselves; stale samples expire via the tracker's TTL.
    const withIdx = chain.map((route, i) => ({
      route,
      i,
      ema: ctx.health.medianLatency(route.id, ctx.op),
    }));
    withIdx.sort((a, b) => {
      if (a.ema !== undefined && b.ema !== undefined) return a.ema - b.ema;
      if (a.ema === undefined && b.ema !== undefined) return -1;
      if (b.ema === undefined && a.ema !== undefined) return 1;
      return a.i - b.i;
    });
    for (let i = 0; i < withIdx.length; i++) chain[i] = withIdx[i]!.route;
    return { chain };
  }

  if (ctx.strategy === "cheapest" || ctx.strategy === "balanced" || ctx.strategy === "quality-first") {
    return policyOrder(ctx);
  }

  return { chain };
}

/** Cost/quality-aware ordering for cheapest/balanced/quality-first. */
function policyOrder(ctx: ArrangeContext): ArrangeResult {
  const chain = ctx.chain;
  const inputTokens = ctx.estimateTokensFn(ctx.req);
  const snapshots = ctx.health.snapshot();
  const byId = new Map(snapshots.map((h) => [h.routeId, h]));

  const estCosts = chain.map((route) => {
    const price = priceLookup(ctx.pricing, route.id, route.model);
    if (!price) return undefined;
    const est = estimateCostUsd(price, inputTokens, ctx.req.max_tokens);
    const ratio = ctx.health.costRatio(route.id) ?? 1;
    return Math.round(est * ratio * 1e6) / 1e6;
  });

  const rawLatencies = chain.map((route) =>
    medianLatencyOf(snapshots, route.id) ?? ctx.health.medianLatency(route.id, ctx.op),
  );
  const sampleCounts = chain.map((route) => {
    const h = byId.get(route.id);
    if (!h) return undefined;
    return (h.complete?.samples ?? 0) + (h.stream?.samples ?? 0) || undefined;
  });
  const latencies = shrinkLatencies(rawLatencies, sampleCounts);

  const successRates = chain.map((route) => {
    const h = byId.get(route.id);
    if (!h || h.successes + h.failures === 0) return undefined;
    return h.successLb ?? h.successRate;
  });

  // Timeout penalty: heavy timeout share erodes the reliability component.
  const successScores = chain.map((route, i) => {
    const s = successRates[i];
    if (s === undefined) return undefined;
    let tr: number | undefined;
    const h = byId.get(route.id);
    tr = h?.timeoutRate;
    return tr === undefined ? s : s * (1 - TIMEOUT_PENALTY * tr);
  });

  if (ctx.strategy === "cheapest") {
    // Priced candidates by ascending estimate; unpriced follow in config order.
    const idx = chain.map((_, i) => i);
    idx.sort((a, b) => {
      const ca = estCosts[a];
      const cb = estCosts[b];
      if (ca !== undefined && cb !== undefined) return ca - cb;
      if (ca !== undefined) return -1;
      if (cb !== undefined) return 1;
      return a - b;
    });
    const ordered = idx.map((i) => chain[i]!);
    return {
      chain: ordered,
      breakdowns: idx.map((i) =>
        estCosts[i] === undefined ? undefined : { cost: 1, speed: 0, reliability: 0, total: 1 },
      ),
    };
  }

  const qualities =
    ctx.strategy === "balanced"
      ? chain.map(() => undefined)
      : chain.map((route) => ctx.outcomes.quality(ctx.task, route.id));

  const signals = { estCosts, latencies, successScores, qualities, weights: ctx.weights };
  const scores = balancedScores(signals);
  const order = orderByScore(scores);

  const w = normalizeWeights(ctx.weights);
  const costRank = rankValues(estCosts, "asc");
  const speedRank = rankValues(latencies, "asc");
  const qualityInput = qualities;
  const anyQuality = qualityInput.some((q) => q !== undefined);
  const reliabilitySource = anyQuality ? qualityInput : successScores;
  const relRank = rankValues(reliabilitySource, "desc").map((v, i) =>
    reliabilitySource[i] === undefined && anyQuality ? 0.5 : v,
  );

  const breakdowns = order.map((originalIdx) => ({
    cost: round6(w.cost * costRank[originalIdx]!),
    speed: round6(w.speed * speedRank[originalIdx]!),
    reliability: round6(w.reliability * relRank[originalIdx]!),
    total: round6(scores[originalIdx]!),
  }));

  return { chain: order.map((i) => chain[i]!), breakdowns };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
