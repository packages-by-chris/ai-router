"""Candidate ordering and multi-signal scoring model."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from ..config.schema import PolicyWeights, RoutingStrategy
from ..types import TokenPrice
from .health import HealthTracker, RouteOpStat
from .outcomes import OutcomeTracker

TIMOUT_PENALTY = 0.25


def estimate_cost_usd(
    price: TokenPrice | dict[str, float],
    input_tokens: int,
    max_tokens: int | None = None,
) -> float:
    """Estimated pre-flight USD cost given an input-token count and a priced route."""
    p_inp = price.input if isinstance(price, TokenPrice) else price.get("input", 0.0)
    p_out = price.output if isinstance(price, TokenPrice) else price.get("output", 0.0)
    output_tokens = max_tokens if max_tokens is not None else input_tokens
    usd = (input_tokens / 1_000_000.0) * p_inp + (output_tokens / 1_000_000.0) * p_out
    return round(usd, 6)


def price_lookup(
    pricing: dict[str, TokenPrice] | None,
    route_id: str,
    model: str,
) -> TokenPrice | None:
    """Price lookup over a pricing table (route id wins, then provider model)."""
    if not pricing:
        return None
    return pricing.get(route_id) or pricing.get(model)


def rank_values(values: Sequence[float | None], direction: str = "asc") -> list[float]:
    """Rank values within [0,1]."""
    known = [v for v in values if v is not None]
    if not known:
        return [0.5 for _ in values]
    out: list[float] = []
    for v in values:
        if v is None:
            out.append(0.5)
        elif len(known) == 1:
            out.append(1.0)
        else:
            better = sum(1 for k in known if (k < v if direction == "asc" else k > v))
            out.append(1.0 - (better / (len(known) - 1)))
    return out


def shrink_latencies(
    values: Sequence[float | None],
    counts: Sequence[int | None],
    shrink_k: int = 3,
) -> list[float | None]:
    """Shrink latency estimates of thinly-sampled routes toward the best well-sampled candidate."""
    solid: list[float] = []
    for i, v in enumerate(values):
        c = counts[i] if i < len(counts) else None
        if v is not None and c is not None and c >= shrink_k:
            solid.append(v)
    if not solid:
        return list(values)
    anchor = min(solid)
    out: list[float | None] = []
    for i, v in enumerate(values):
        if v is None:
            out.append(None)
            continue
        cnt = counts[i] if i < len(counts) else None
        n: int = int(cnt) if cnt is not None else 0
        if n >= shrink_k or shrink_k <= 0:
            out.append(v)
        else:
            out.append((float(n) * v + float(shrink_k - n) * anchor) / float(shrink_k))
    return out


@dataclass
class PolicySignals:
    estCosts: list[float | None]
    latencies: list[float | None]
    successScores: list[float | None] | None = None
    qualities: list[float | None] | None = None
    weights: PolicyWeights | None = None


@dataclass
class ScoreBreakdown:
    cost: float
    speed: float
    reliability: float
    total: float


def normalize_weights(w: PolicyWeights | None) -> tuple[float, float, float]:
    cost = w.cost if w and w.cost is not None else 0.5
    speed = w.speed if w and w.speed is not None else 0.3
    reliability = w.reliability if w and w.reliability is not None else 0.2
    total = cost + speed + reliability
    if total <= 0:
        return (0.5, 0.3, 0.2)
    return (cost / total, speed / total, reliability / total)


def balanced_scores(signals: PolicySignals) -> list[float]:
    w_cost, w_speed, w_rel = normalize_weights(signals.weights)
    cost_score = rank_values(signals.estCosts, "asc")
    speed_score = rank_values(signals.latencies, "asc")
    quality_input = signals.qualities or []
    any_quality = any(q is not None for q in quality_input)
    reliability_source = quality_input if any_quality else (signals.successScores or [])
    rel_ranks = rank_values(reliability_source, "desc")
    reliability_score = [
        0.5 if (i < len(reliability_source) and reliability_source[i] is None and any_quality) else rel_ranks[i]
        for i in range(len(rel_ranks))
    ]
    return [
        w_cost * cost_score[i] + w_speed * speed_score[i] + w_rel * reliability_score[i] for i in range(len(cost_score))
    ]


def order_by_score(scores: Sequence[float]) -> list[int]:
    """Orders indices by score descending; ties keep original order."""
    with_idx = [(score, i) for i, score in enumerate(scores)]
    with_idx.sort(key=lambda x: (-x[0], x[1]))
    return [x[1] for x in with_idx]


@dataclass
class ArrangeContext:
    strategy: RoutingStrategy | None
    op: RouteOpStat
    rng: Callable[[], float]
    rrCounter: int
    health: HealthTracker
    outcomes: OutcomeTracker
    estimateTokensFn: Callable[[Any], int]
    req: Any
    chain: list[Any]
    task: str | None = None
    pricing: dict[str, TokenPrice] | None = None
    weights: PolicyWeights | None = None


@dataclass
class ArrangeResult:
    chain: list[Any]
    breakdowns: Sequence[ScoreBreakdown | None] | None = None
    explored: bool = False


def _round6(n: float) -> float:
    return round(n, 6)


def arrange_chain(ctx: ArrangeContext) -> ArrangeResult:
    chain = list(ctx.chain)
    if len(chain) <= 1:
        return ArrangeResult(chain=chain)

    if ctx.strategy == "round-robin":
        offset = ctx.rrCounter % len(chain)
        if offset > 0:
            chain = chain[offset:] + chain[:offset]
        return ArrangeResult(chain=chain)

    if ctx.strategy == "weighted":
        weights = [r.weight if getattr(r, "weight", None) and r.weight > 0 else 1.0 for r in chain]
        total = sum(weights)
        pick = ctx.rng() * total
        offset = 0
        for i, w in enumerate(weights):
            pick -= w
            if pick <= 0:
                offset = i
                break
        if offset > 0:
            chain = chain[offset:] + chain[:offset]
        return ArrangeResult(chain=chain)

    if ctx.strategy == "least-latency":
        with_idx = [(ctx.health.medianLatency(r.id, ctx.op), i, r) for i, r in enumerate(chain)]

        def sort_key(item: tuple[float | None, int, Any]) -> tuple[int, float, int]:
            val, idx, _ = item
            if val is None:
                return (0, 0.0, idx)  # unobserved sort first
            return (1, val, idx)

        with_idx.sort(key=sort_key)
        return ArrangeResult(chain=[item[2] for item in with_idx])

    if ctx.strategy in ("cheapest", "balanced", "quality-first"):
        return _policy_order(ctx)

    return ArrangeResult(chain=chain)


def _policy_order(ctx: ArrangeContext) -> ArrangeResult:
    chain = ctx.chain
    input_tokens = ctx.estimateTokensFn(ctx.req)
    snapshots = ctx.health.snapshot()
    by_id = {h.routeId: h for h in snapshots}

    est_costs: list[float | None] = []
    for route in chain:
        price = price_lookup(ctx.pricing, route.id, route.model)
        if not price:
            est_costs.append(None)
            continue
        max_tokens = (
            getattr(ctx.req, "max_tokens", None) if not isinstance(ctx.req, dict) else ctx.req.get("max_tokens")
        )
        est = estimate_cost_usd(price, input_tokens, max_tokens)
        ratio = ctx.health.costRatio(route.id) or 1.0
        est_costs.append(round(est * ratio, 6))

    raw_latencies = [
        (by_id[r.id].p50LatencyMs if r.id in by_id else None) or ctx.health.medianLatency(r.id, ctx.op) for r in chain
    ]
    sample_counts: list[int | None] = []
    for r in chain:
        if r.id in by_id:
            h_obj = by_id[r.id]
            c_samples = h_obj.complete.samples if h_obj.complete is not None else 0
            s_samples = h_obj.stream.samples if h_obj.stream is not None else 0
            sample_counts.append(c_samples + s_samples)
        else:
            sample_counts.append(None)

    latencies = shrink_latencies(raw_latencies, sample_counts)

    success_rates: list[float | None] = []
    for r in chain:
        h = by_id.get(r.id)
        if not h or (h.successes + h.failures == 0):
            success_rates.append(None)
        else:
            success_rates.append(h.successLb if h.successLb is not None else h.successRate)

    success_scores: list[float | None] = []
    for i, r in enumerate(chain):
        s = success_rates[i]
        if s is None:
            success_scores.append(None)
            continue
        h = by_id.get(r.id)
        tr = h.timeoutRate if h else None
        success_scores.append(s if tr is None else s * (1.0 - TIMOUT_PENALTY * tr))

    if ctx.strategy == "cheapest":
        idx_list = list(range(len(chain)))

        def cheapest_key(i: int) -> tuple[int, float, int]:
            c = est_costs[i]
            if c is not None:
                return (0, c, i)
            return (1, 0.0, i)

        idx_list.sort(key=cheapest_key)
        ordered_chain = [chain[i] for i in idx_list]
        breakdowns = [
            None if est_costs[i] is None else ScoreBreakdown(cost=1.0, speed=0.0, reliability=0.0, total=1.0)
            for i in idx_list
        ]
        return ArrangeResult(chain=ordered_chain, breakdowns=breakdowns)

    qualities: list[float | None] = (
        [None] * len(chain) if ctx.strategy == "balanced" else [ctx.outcomes.quality(ctx.task, r.id) for r in chain]
    )

    signals = PolicySignals(
        estCosts=est_costs,
        latencies=latencies,
        successScores=success_scores,
        qualities=qualities,
        weights=ctx.weights,
    )
    scores = balanced_scores(signals)
    order = order_by_score(scores)

    w_cost, w_speed, w_rel = normalize_weights(ctx.weights)
    cost_rank = rank_values(est_costs, "asc")
    speed_rank = rank_values(latencies, "asc")
    any_quality = any(q is not None for q in qualities)
    rel_source = qualities if any_quality else success_scores
    rel_ranks = rank_values(rel_source, "desc")
    rel_rank = [
        0.5 if (i < len(rel_source) and rel_source[i] is None and any_quality) else rel_ranks[i]
        for i in range(len(rel_ranks))
    ]

    breakdowns = [
        ScoreBreakdown(
            cost=_round6(w_cost * cost_rank[orig_i]),
            speed=_round6(w_speed * speed_rank[orig_i]),
            reliability=_round6(w_rel * rel_rank[orig_i]),
            total=_round6(scores[orig_i]),
        )
        for orig_i in order
    ]

    return ArrangeResult(chain=[chain[i] for i in order], breakdowns=breakdowns)
