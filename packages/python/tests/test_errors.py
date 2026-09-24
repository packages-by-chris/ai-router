"""Tests for error taxonomy, classification, and retryable / key-related predicates."""

from ai_router import (
    AllRoutesFailedError,
    AttemptRecord,
    classify_status,
    is_key_related_kind,
    is_retryable_kind,
)


def test_classify_status() -> None:
    assert classify_status(400) == "invalid_request"
    assert classify_status(401) == "auth"
    assert classify_status(403) == "permission"
    assert classify_status(404) == "not_found"
    assert classify_status(429) == "rate_limit"
    assert classify_status(500) == "server"
    assert classify_status(502) == "server"
    assert classify_status(503) == "server"
    assert classify_status(200) == "unknown"


def test_predicates() -> None:
    assert is_retryable_kind("rate_limit") is True
    assert is_retryable_kind("server") is True
    assert is_retryable_kind("network") is True
    assert is_retryable_kind("timeout") is True
    assert is_retryable_kind("auth") is False
    assert is_retryable_kind("invalid_request") is False

    assert is_key_related_kind("rate_limit") is True
    assert is_key_related_kind("auth") is True
    assert is_key_related_kind("permission") is True
    assert is_key_related_kind("server") is False


def test_all_routes_failed_retry_after() -> None:
    attempts = [
        AttemptRecord(route_id="r1", provider="openai", model="m1", outcome="error", attempts=2, retry_after_ms=5000),
        AttemptRecord(
            route_id="r2", provider="anthropic", model="m2", outcome="error", attempts=2, retry_after_ms=2000
        ),
    ]
    err = AllRoutesFailedError(attempts)
    assert err.retryAfterMs == 2000
