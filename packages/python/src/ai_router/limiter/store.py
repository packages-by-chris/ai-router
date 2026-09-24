"""Rate limit store interface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass
class RateLimitDecision:
    allowed: bool
    retryAfterMs: int


@runtime_checkable
class RateLimitStore(Protocol):
    async def take(self, key: str, cost: int, windowMs: int, limit: int) -> RateLimitDecision: ...

    async def record(self, key: str, cost: int, windowMs: int) -> None: ...

    def used(self, key: str, windowMs: int) -> float: ...

    def snapshot(self) -> dict[str, float]: ...
