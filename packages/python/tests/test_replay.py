"""Unit tests for offline routing strategy replay simulation."""

from ai_router import parse_config
from ai_router.routing.replay import ReplayEvent, ReplayOptions, ReplayRequest, replay_strategy


def test_replay_fallback_strategy():
    config = parse_config(
        {
            "strategy": "fallback",
            "routes": [
                {"id": "primary", "provider": "openai", "model": "gpt-4o", "apiKey": "k1"},
                {"id": "secondary", "provider": "anthropic", "model": "claude-3-5-sonnet", "apiKey": "k2"},
            ],
        }
    )

    events = [
        ReplayEvent(
            request=ReplayRequest(model="primary", messages=[{"role": "user", "content": "hi"}]),
            servedRouteId="primary",
            success=True,
            latencyMs=120,
        ),
        ReplayEvent(
            request=ReplayRequest(model="primary", messages=[{"role": "user", "content": "hi again"}]),
            servedRouteId="primary",
            success=False,
            latencyMs=500,
        ),
    ]

    res = replay_strategy(config, strategy="fallback", events=events, opts=ReplayOptions())

    assert len(res.chosen) == 2
    assert len(res.orders) == 2
    # In fallback strategy, primary is ordered first
    assert res.chosen[0] == "primary"
    assert res.chosen[1] == "primary"


def test_replay_cheapest_strategy():
    config = parse_config(
        {
            "strategy": "cheapest",
            "routes": [
                {
                    "id": "expensive",
                    "provider": "openai",
                    "model": "gpt-4o",
                    "apiKey": "k1",
                },
                {
                    "id": "cheap",
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "apiKey": "k2",
                },
            ],
        }
    )

    events = [
        ReplayEvent(
            request=ReplayRequest(model="expensive", messages=[{"role": "user", "content": "test"}]),
            servedRouteId="expensive",
            success=True,
            latencyMs=100,
        )
    ]

    from ai_router.types import TokenPrice

    pricing = {
        "expensive": TokenPrice(input=5.0, output=15.0),
        "cheap": TokenPrice(input=0.15, output=0.60),
    }

    res = replay_strategy(config, strategy="cheapest", events=events, opts=ReplayOptions(pricing=pricing))

    assert len(res.chosen) == 1
    # Cheapest strategy should choose 'cheap'
    assert res.chosen[0] == "cheap"


def test_replay_least_latency_flips_mid_log():
    config = parse_config(
        {
            "routes": [
                {"id": "a", "provider": "openai", "model": "gpt-4o", "apiKey": "k1"},
                {"id": "b", "provider": "anthropic", "model": "claude-3-5-sonnet", "apiKey": "k2"},
            ]
        }
    )
    events = [
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}]), servedRouteId="a", success=True, latencyMs=400),
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}]), servedRouteId="b", success=True, latencyMs=100),
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}]), servedRouteId="b", success=True, latencyMs=110),
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}]), servedRouteId="b", success=True, latencyMs=90),
    ]

    result = replay_strategy(config, "least-latency", events)
    assert result.chosen[0] == "a"  # cold start: config order
    assert result.chosen[2] == "b"  # learned: b is faster
    assert result.chosen[3] == "b"


def test_replay_quality_first_learns():
    config = parse_config(
        {
            "routes": [
                {"id": "a", "provider": "openai", "model": "gpt-4o", "apiKey": "k1"},
                {"id": "b", "provider": "anthropic", "model": "claude-3-5-sonnet", "apiKey": "k2"},
            ]
        }
    )
    events = [
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}]), servedRouteId="a", success=True, quality=0.0),
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}]), servedRouteId="b", success=True, quality=1.0),
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}]), servedRouteId="b", success=True, quality=1.0),
    ]

    result = replay_strategy(config, "quality-first", events)
    assert result.chosen[2] == "b"


def test_replay_round_robin_deterministic():
    config = parse_config(
        {
            "routes": [
                {"id": "a", "provider": "openai", "model": "gpt-4o", "apiKey": "k1"},
                {"id": "b", "provider": "anthropic", "model": "claude-3-5-sonnet", "apiKey": "k2"},
            ]
        }
    )
    events = [
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}])),
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}])),
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}])),
        ReplayEvent(request=ReplayRequest(model="a", messages=[{"role": "user", "content": "hi"}])),
    ]

    r1 = replay_strategy(config, "round-robin", events, ReplayOptions(rng=lambda: 0.5))
    r2 = replay_strategy(config, "round-robin", events, ReplayOptions(rng=lambda: 0.5))
    assert r1.orders == r2.orders
    assert r1.chosen == ["a", "b", "a", "b"]

