"""Tests for in-process route health tracking and Wilson lower bound."""

from ai_router import HealthTracker, wilson_lower_bound


def test_wilson_lower_bound() -> None:
    score1 = wilson_lower_bound(3, 3)
    score2 = wilson_lower_bound(12, 13)
    assert score1 is not None and score2 is not None
    assert score1 < score2  # 3/3 has higher uncertainty than 12/13


def test_health_tracker_success_and_failure() -> None:
    tracker = HealthTracker()
    tracker.recordSuccess("r1", latencyMs=100.0, op="complete")
    tracker.recordSuccess("r1", latencyMs=200.0, op="complete")
    tracker.recordFailure("r1", "timeout", latencyMs=500.0, op="complete")

    snap = tracker.snapshot()
    assert len(snap) == 1
    assert snap[0].routeId == "r1"
    assert snap[0].successes == 2
    assert snap[0].failures == 1
    assert snap[0].p50LatencyMs is not None


def test_key_cooldown() -> None:
    tracker = HealthTracker()
    tracker.recordFailure("r1", "rate_limit", keyIndex=0, retryAfterMs=10000)
    assert tracker.keyOnCooldown("r1", 0) is True
    assert tracker.keyOnCooldown("r1", 1) is False
