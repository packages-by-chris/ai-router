"""Error taxonomy for ai-router.

Classification drives the three distinct recovery layers:
  1. retry same route+key      -> is_retryable_kind
  2. rotate key on same route  -> is_key_related_kind
  3. fall back to next route   -> engine always does after a route exhausts
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

ErrorKind = Literal[
    "rate_limit",
    "auth",
    "permission",
    "not_found",
    "invalid_request",
    "server",
    "network",
    "timeout",
    "unknown",
]


class AIRouterError(Exception):
    """Base exception for all ai-router errors."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class ConfigError(AIRouterError):
    """Raised when configuration validation or environment interpolation fails."""


class UnsupportedProviderError(AIRouterError):
    """Raised when a requested provider is not supported."""


class DeadlineExceededError(AIRouterError):
    """Thrown when a call exceeds its deadline_ms wall-clock budget."""

    def __init__(self, deadline_ms: int) -> None:
        super().__init__(f"call exceeded its {deadline_ms}ms deadline")
        self.deadline_ms = deadline_ms


class RateLimitedError(AIRouterError):
    """Thrown when a route's rpm/tpm budget is exhausted."""

    def __init__(self, route_id: str, retry_after_ms: int) -> None:
        super().__init__(f'route "{route_id}" is rate-limited (retry after {retry_after_ms}ms)')
        self.route_id = route_id
        self.retry_after_ms = retry_after_ms


class ProviderError(AIRouterError):
    """Error returned by or classified from an upstream LLM provider."""

    def __init__(
        self,
        provider: str,
        kind: ErrorKind,
        message: str,
        *,
        status: int | None = None,
        retry_after_ms: int | None = None,
        body: Any = None,
        cause: Any = None,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.kind = kind
        self.status = status
        self.retry_after_ms = retry_after_ms
        self.body = body
        self.cause = cause

    @property
    def retryAfterMs(self) -> int | None:
        return self.retry_after_ms


@dataclass
class AttemptRecord:
    route_id: str
    provider: str
    model: str
    outcome: Literal[
        "error",
        "skipped_rate_limit",
        "skipped_budget",
        "circuit_open",
        "unsupported",
        "capability_mismatch",
    ]
    attempts: int
    key_index: int | None = None
    kind: ErrorKind | None = None
    message: str | None = None
    retry_after_ms: int | None = None


class AllRoutesFailedError(AIRouterError):
    """Raised when all candidates in the fallback chain have been exhausted."""

    def __init__(self, attempts: list[AttemptRecord]) -> None:
        super().__init__(f"all routes failed ({len(attempts)} attempted)")
        self.attempts = attempts
        delays = [a.retry_after_ms for a in attempts if isinstance(a.retry_after_ms, (int, float))]
        self.retry_after_ms: int | None = int(min(delays)) if delays else None

    @property
    def retryAfterMs(self) -> int | None:
        return self.retry_after_ms


def classify_status(status: int) -> ErrorKind:
    """Classifies an HTTP status code into an ErrorKind."""
    if status == 400:
        return "invalid_request"
    if status == 401:
        return "auth"
    if status == 403:
        return "permission"
    if status == 404:
        return "not_found"
    if status == 429:
        return "rate_limit"
    if status >= 500:
        return "server"
    return "unknown"


def is_retryable_kind(kind: ErrorKind) -> bool:
    """Whether the same route+key should be retried with backoff."""
    return kind in ("rate_limit", "server", "network", "timeout")


def is_key_related_kind(kind: ErrorKind) -> bool:
    """Whether a different API key on the same route could change the outcome."""
    return kind in ("rate_limit", "auth", "permission")


class GuardrailBlockedError(AIRouterError):
    """Raised when an input or output guardrail vetoes a request/response."""

    def __init__(
        self,
        phase: Literal["input", "output"] | str,
        guardrail: str,
        reason: str | None = None,
    ) -> None:
        msg = f'guardrail "{guardrail}" blocked {phase}' + (f": {reason}" if reason else "")
        super().__init__(msg)
        self.phase = phase
        self.guardrail = guardrail
        self.reason = reason
