"""Tests for candidate ordering and strategy scoring."""

from ai_router import (
    ArrangeContext,
    HealthTracker,
    NormalizedRoute,
    OutcomeTracker,
    TokenPrice,
    arrange_chain,
    estimate_cost_usd,
    order_by_score,
)


def test_estimate_cost_usd() -> None:
    price = TokenPrice(input=1.0, output=2.0)  # $1 per 1M input, $2 per 1M output
    cost = estimate_cost_usd(price, input_tokens=1000, max_tokens=1000)
    assert cost == 0.003


def test_order_by_score() -> None:
    scores = [0.2, 0.9, 0.5]
    order = order_by_score(scores)
    assert order == [1, 2, 0]


def test_arrange_chain_fallback() -> None:
    r1 = NormalizedRoute(id="r1", provider="openai", model="m1")
    r2 = NormalizedRoute(id="r2", provider="anthropic", model="m2")
    ctx = ArrangeContext(
        strategy="fallback",
        op="complete",
        rng=lambda: 0.5,
        rrCounter=0,
        health=HealthTracker(),
        outcomes=OutcomeTracker(),
        estimateTokensFn=lambda req: 100,
        req={"messages": []},
        chain=[r1, r2],
    )
    result = arrange_chain(ctx)
    assert [r.id for r in result.chain] == ["r1", "r2"]


def test_arrange_chain_round_robin() -> None:
    r1 = NormalizedRoute(id="r1", provider="openai", model="m1")
    r2 = NormalizedRoute(id="r2", provider="anthropic", model="m2")
    ctx = ArrangeContext(
        strategy="round-robin",
        op="complete",
        rng=lambda: 0.5,
        rrCounter=1,
        health=HealthTracker(),
        outcomes=OutcomeTracker(),
        estimateTokensFn=lambda req: 100,
        req={"messages": []},
        chain=[r1, r2],
    )
    result = arrange_chain(ctx)
    assert [r.id for r in result.chain] == ["r2", "r1"]
