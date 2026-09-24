"""Application-recorded outcome memory for quality-aware routing."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any

ALPHA_DEFAULT = 0.3
HALF_LIFE_DEFAULT = 30 * 60_000
NEUTRAL = 0.5


@dataclass
class OutcomeEvent:
    routeId: str
    task: str | None = None
    success: bool = True
    quality: float | None = None
    latencyMs: float | None = None
    costUsd: float | None = None


@dataclass
class OutcomeStats:
    routeId: str
    task: str
    samples: int
    successRate: float
    avgQuality: float | None = None
    avgLatencyMs: float | None = None
    avgCostUsd: float | None = None


@dataclass
class Bucket:
    samples: int
    successRateEma: float
    lastAt: float
    qualityEma: float | None = None
    latencyEma: float | None = None
    costEma: float | None = None


def _ema(prev: float | None, next_val: float, alpha: float) -> float:
    if prev is None:
        return next_val
    return prev + alpha * (next_val - prev)


def _round6(n: float) -> float:
    return round(n, 6)


class OutcomeTracker:
    def __init__(
        self,
        alpha: float = ALPHA_DEFAULT,
        halfLifeMs: int = HALF_LIFE_DEFAULT,
    ) -> None:
        self.alpha = min(1.0, max(0.001, alpha))
        self.halfLifeMs = halfLifeMs
        self._buckets: dict[str, Bucket] = {}

    def _decay(self, b: Bucket, now: float) -> None:
        if self.halfLifeMs <= 0:
            return
        elapsed = now - b.lastAt
        if elapsed <= 0:
            return
        d = math.pow(0.5, elapsed / self.halfLifeMs)
        b.successRateEma = NEUTRAL + (b.successRateEma - NEUTRAL) * d
        if b.qualityEma is not None:
            b.qualityEma = NEUTRAL + (b.qualityEma - NEUTRAL) * d

    def record(self, event: OutcomeEvent | dict[str, Any]) -> None:
        if isinstance(event, dict):
            ev = OutcomeEvent(**event)
        else:
            ev = event

        if ev.quality is not None and not (0.0 <= ev.quality <= 1.0):
            return

        now = time.time() * 1000.0
        key = f"{ev.task or ''}|{ev.routeId}"
        b = self._buckets.get(key)
        if not b:
            b = Bucket(samples=0, successRateEma=1.0, lastAt=now)
            self._buckets[key] = b

        self._decay(b, now)
        b.samples += 1
        b.successRateEma = _ema(b.successRateEma, 0.0 if ev.success is False else 1.0, self.alpha)
        if ev.quality is not None:
            b.qualityEma = _ema(b.qualityEma, ev.quality, self.alpha)
        if ev.latencyMs is not None:
            b.latencyEma = _ema(b.latencyEma, ev.latencyMs, self.alpha)
        if ev.costUsd is not None:
            b.costEma = _ema(b.costEma, ev.costUsd, self.alpha)
        b.lastAt = now

    def quality(self, task: str | None, routeId: str) -> float | None:
        key = f"{task or ''}|{routeId}"
        b = self._buckets.get(key)
        if not b or b.qualityEma is None:
            return None
        now = time.time() * 1000.0
        self._decay(b, now)
        return b.qualityEma

    def snapshot(self) -> list[OutcomeStats]:
        now = time.time() * 1000.0
        out: list[OutcomeStats] = []
        for key, b in self._buckets.items():
            sep = key.find("|")
            task = key[:sep]
            route_id = key[sep + 1 :]
            self._decay(b, now)
            out.append(
                OutcomeStats(
                    routeId=route_id,
                    task=task,
                    samples=b.samples,
                    successRate=_round6(b.successRateEma),
                    avgQuality=_round6(b.qualityEma) if b.qualityEma is not None else None,
                    avgLatencyMs=_round6(b.latencyEma) if b.latencyEma is not None else None,
                    avgCostUsd=_round6(b.costEma) if b.costEma is not None else None,
                )
            )
        return out
