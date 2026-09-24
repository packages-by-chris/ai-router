"""In-process sliding-window rate limit store."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from .store import RateLimitDecision, RateLimitStore


@dataclass
class Entry:
    ts: float
    cost: float


class MemoryStore(RateLimitStore):
    def __init__(
        self,
        now: Callable[[], float] | None = None,
        prune_interval: int = 1000,
    ) -> None:
        self._now = now or (lambda: time.time() * 1000.0)
        self._prune_interval = prune_interval
        self._entries: dict[str, list[Entry]] = {}
        self._calls = 0

    async def take(self, key: str, cost: int, windowMs: int, limit: int) -> RateLimitDecision:
        self._maybe_prune_all(windowMs)
        entries = self._prune(key, windowMs)
        used_val = sum(e.cost for e in entries)
        if used_val + cost <= limit:
            entries.append(Entry(ts=self._now(), cost=float(cost)))
            return RateLimitDecision(allowed=True, retryAfterMs=0)

        oldest = entries[0] if entries else None
        retry_after_ms = int(max(1.0, oldest.ts + windowMs - self._now())) if oldest else 1
        return RateLimitDecision(allowed=False, retryAfterMs=retry_after_ms)

    async def record(self, key: str, cost: int, windowMs: int) -> None:
        self._maybe_prune_all(windowMs)
        entries = self._prune(key, windowMs)
        entries.append(Entry(ts=self._now(), cost=float(cost)))

    def used(self, key: str, windowMs: int) -> float:
        entries = self._prune(key, windowMs)
        return sum(e.cost for e in entries)

    def snapshot(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for k, entries in self._entries.items():
            if entries:
                out[k] = sum(e.cost for e in entries)
        return out

    def _maybe_prune_all(self, window_ms: int) -> None:
        self._calls += 1
        if self._calls < self._prune_interval:
            return
        self._calls = 0
        cutoff = self._now() - window_ms
        to_delete: list[str] = []
        for k, entries in self._entries.items():
            while entries and entries[0].ts <= cutoff:
                entries.pop(0)
            if not entries:
                to_delete.append(k)
        for k in to_delete:
            del self._entries[k]

    def _prune(self, key: str, window_ms: int) -> list[Entry]:
        if key not in self._entries:
            self._entries[key] = []
        entries = self._entries[key]
        cutoff = self._now() - window_ms
        while entries and entries[0].ts <= cutoff:
            entries.pop(0)
        return entries
