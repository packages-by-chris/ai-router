"""Unit tests for task outcome tracking and quality-first adaptive scoring."""

from ai_router.routing.outcomes import OutcomeEvent, OutcomeTracker


def test_outcome_tracker_basic_stats():
    tracker = OutcomeTracker(alpha=0.3, halfLifeMs=60000)

    tracker.record(OutcomeEvent(routeId="r1", task="code-generation", success=True, quality=0.95))
    tracker.record(OutcomeEvent(routeId="r1", task="code-generation", success=True, quality=0.85))
    tracker.record(OutcomeEvent(routeId="r1", task="code-generation", success=False, quality=0.10))

    qual = tracker.quality("code-generation", "r1")
    assert qual is not None
    assert 0.0 < qual < 1.0

    snaps = tracker.snapshot()
    assert len(snaps) == 1
    s = snaps[0]
    assert s.routeId == "r1"
    assert s.task == "code-generation"
    assert s.samples == 3
    assert 0.0 < s.successRate < 1.0


def test_outcome_tracker_sample_decay():
    tracker = OutcomeTracker(alpha=0.5, halfLifeMs=5000)

    tracker.record(OutcomeEvent(routeId="r1", task="summary", success=True, quality=1.0))
    qual1 = tracker.quality("summary", "r1")
    assert qual1 is not None

    snaps = tracker.snapshot()
    assert len(snaps) == 1
    assert snaps[0].samples == 1
