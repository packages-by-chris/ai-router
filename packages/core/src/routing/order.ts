/**
 * Candidate ordering for the cost/quality-aware strategies.
 *
 * All signals are deterministic and derived from three sources:
 *   - declared pricing (estimated USD per request)
 *   - observed health (median latency, success-rate EMA)
 *   - application-recorded outcome quality ("quality-first")
 *
 * Missing data degrades gracefully to a neutral 0.5 component so partial
 * configuration never disqualifies candidates.
 */

import type { TokenPrice } from "../types.js";
import type { RouteHealthSnapshot } from "./health.js";

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

/** Rank-normalize values into [0,1] where the smallest value maps to 1. */
function ascendingRanks(values: Array<number | undefined>): Array<number> {
  const known = values.filter((v): v is number => v !== undefined);
  return values.map((v) => {
    if (v === undefined || known.length <= 1) return 0.5;
    const cheaper = known.filter((k) => k < v).length;
    return 1 - cheaper / (known.length - 1);
  });
}

/** Rank-normalize values into [0,1] where the largest value maps to 1. */
function descendingRanks(values: Array<number | undefined>): Array<number> {
  return ascendingRanks(values).map((s) => (values.length <= 1 ? s : 1 - s));
}

export interface PolicySignals {
  /** Estimated per-candidate USD cost (undefined = unpriced). */
  estCosts: Array<number | undefined>;
  /** Observed median latencies (undefined = unobserved). */
  latencies: Array<number | undefined>;
  /** Observed success rates [0,1] (undefined = unobserved). */
  successRates: Array<number | undefined>;
  /** Application-recorded quality EMAs (undefined = unrecorded). */
  qualities: Array<number | undefined>;
}

/**
 * Balanced score per candidate in [0,1]:
 *   0.5·cost + 0.3·speed + 0.2·reliability (+ quality bonus when recorded).
 * Quality replaces reliability when at least one candidate has data.
 */
export function balancedScores(signals: PolicySignals): number[] {
  const costScore = ascendingRanks(signals.estCosts);
  const speedScore = descendingRanks(signals.latencies);
  const anyQuality = signals.qualities.some((q) => q !== undefined);
  const reliabilityScore = anyQuality
    ? descendingRanks(signals.qualities).map((v, i) =>
        signals.qualities[i] === undefined ? 0.5 : v,
      )
    : descendingRanks(signals.successRates);
  return costScore.map(
    (c, i) => 0.5 * c + 0.3 * speedScore[i]! + 0.2 * reliabilityScore[i]!,
  );
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
