"""In-process route health tracking."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Literal

RING_CAPACITY = 128
KEY_COOLDOWN_CAP_MS = 5 * 60_000
DEFAULT_HALF_LIFE_MS = 30 * 60_000
DEFAULT_SAMPLE_TTL_MS = 10 * 60_000

RouteOpStat = Literal["complete", "stream"]
WILSON_Z = 1.96
SUCCESS_EMA_ALPHA = 0.3


def wilson_lower_bound(successes: float, total: float) -> float | None:
    """Wilson lower bound at ~95% confidence over counts."""
    if total <= 0:
        return None
    p = successes / total
    z2 = WILSON_Z * WILSON_Z
    n = total
    denom = 1 + z2 / n
    centre = p + z2 / (2 * n)
    spread = WILSON_Z * math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
    return max(0.0, min(1.0, (centre - spread) / denom))


@dataclass
class KeyHealth:
    keyIndex: int
    failures: int
    cooldownRemainingMs: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "keyIndex": self.keyIndex,
            "failures": self.failures,
            "cooldownRemainingMs": self.cooldownRemainingMs,
        }


@dataclass
class OpLatencyPercentiles:
    p50Ms: float | None = None
    p95Ms: float | None = None
    p99Ms: float | None = None
    samples: int = 0
    ttfb: OpLatencyPercentiles | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {"samples": self.samples}
        if self.p50Ms is not None:
            res["p50Ms"] = self.p50Ms
        if self.p95Ms is not None:
            res["p95Ms"] = self.p95Ms
        if self.p99Ms is not None:
            res["p99Ms"] = self.p99Ms
        if self.ttfb is not None:
            res["ttfb"] = self.ttfb.to_dict()
        return res


@dataclass
class RouteHealthSnapshot:
    routeId: str
    successes: int
    failures: int
    byKind: dict[str, int]
    successRate: float
    keys: list[KeyHealth]
    p50LatencyMs: float | None = None
    p95LatencyMs: float | None = None
    p99LatencyMs: float | None = None
    p50TtfbMs: float | None = None
    p95TtfbMs: float | None = None
    p99TtfbMs: float | None = None
    successLb: float | None = None
    timeoutRate: float | None = None
    complete: OpLatencyPercentiles | None = None
    stream: OpLatencyPercentiles | None = None
    costRatio: float | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {
            "routeId": self.routeId,
            "successes": self.successes,
            "failures": self.failures,
            "byKind": self.byKind,
            "successRate": self.successRate,
            "keys": [k.to_dict() for k in self.keys],
        }
        if self.p50LatencyMs is not None:
            res["p50LatencyMs"] = self.p50LatencyMs
        if self.p95LatencyMs is not None:
            res["p95LatencyMs"] = self.p95LatencyMs
        if self.p99LatencyMs is not None:
            res["p99LatencyMs"] = self.p99LatencyMs
        if self.p50TtfbMs is not None:
            res["p50TtfbMs"] = self.p50TtfbMs
        if self.p95TtfbMs is not None:
            res["p95TtfbMs"] = self.p95TtfbMs
        if self.p99TtfbMs is not None:
            res["p99TtfbMs"] = self.p99TtfbMs
        if self.successLb is not None:
            res["successLb"] = self.successLb
        if self.timeoutRate is not None:
            res["timeoutRate"] = self.timeoutRate
        if self.complete is not None:
            res["complete"] = self.complete.to_dict()
        if self.stream is not None:
            res["stream"] = self.stream.to_dict()
        if self.costRatio is not None:
            res["costRatio"] = self.costRatio
        return res


class TimedRing:
    def __init__(self) -> None:
        self.buf = [0.0] * RING_CAPACITY
        self.ts = [0.0] * RING_CAPACITY
        self.size = 0
        self.head = 0

    def push(self, value: float, now: float) -> None:
        self.buf[self.head] = value
        self.ts[self.head] = now
        self.head = (self.head + 1) % RING_CAPACITY
        if self.size < RING_CAPACITY:
            self.size += 1

    def collect_within(self, now: float, ttl: float) -> list[float]:
        out: list[float] = []
        for i in range(self.size):
            idx = (self.head - 1 - i + RING_CAPACITY) % RING_CAPACITY
            if ttl > 0 and now - self.ts[idx] > ttl:
                break
            out.append(self.buf[idx])
        return out


def _percentile_of(values: list[float], p: float) -> float | None:
    if not values:
        return None
    sorted_vals = sorted(values)
    idx = min(len(sorted_vals) - 1, math.ceil(p * len(sorted_vals)) - 1)
    return round(sorted_vals[max(0, idx)], 2)


@dataclass
class OpStat:
    lat: TimedRing = field(default_factory=TimedRing)
    ttfb: TimedRing = field(default_factory=TimedRing)


@dataclass
class KindTally:
    n: int = 0
    w: float = 0.0


@dataclass
class KeyState:
    failures: int = 0
    cooldownUntil: float = 0.0


class RouteState:
    def __init__(self, now: float) -> None:
        self.successes = 0
        self.failures = 0
        self.byKind: dict[str, KindTally] = {}
        self.successRateEma = 1.0
        self.succW = 0.0
        self.failW = 0.0
        self.succLastAt = now
        self.ops: dict[str, OpStat] = {"complete": OpStat(), "stream": OpStat()}
        self.keys: dict[int, KeyState] = {}
        self.costRatioEma: float | None = None
        self.costRatioLastAt: float | None = None


def _round4(n: float) -> float:
    return round(n, 4)


class HealthTracker:
    def __init__(
        self,
        halfLifeMs: int = DEFAULT_HALF_LIFE_MS,
        sampleTtlMs: int = DEFAULT_SAMPLE_TTL_MS,
    ) -> None:
        self.halfLifeMs = halfLifeMs
        self.sampleTtlMs = sampleTtlMs
        self._routes: dict[str, RouteState] = {}

    def _state_for(self, route_id: str, now: float) -> RouteState:
        if route_id not in self._routes:
            self._routes[route_id] = RouteState(now)
        return self._routes[route_id]

    def _decay_counts(self, s: RouteState, now: float) -> None:
        if self.halfLifeMs <= 0:
            return
        elapsed = now - s.succLastAt
        if elapsed <= 0:
            return
        d = math.pow(0.5, elapsed / self.halfLifeMs)
        s.succW *= d
        s.failW *= d
        for v in s.byKind.values():
            v.w *= d
        neutral = 0.5
        s.successRateEma = neutral + (s.successRateEma - neutral) * d
        s.succLastAt = now

    def _decay_cost(self, s: RouteState, now: float) -> None:
        if self.halfLifeMs <= 0 or s.costRatioEma is None or s.costRatioLastAt is None:
            return
        elapsed = now - s.costRatioLastAt
        if elapsed <= 0:
            return
        d = math.pow(0.5, elapsed / self.halfLifeMs)
        s.costRatioEma = 1.0 + (s.costRatioEma - 1.0) * d
        s.costRatioLastAt = now

    def _decayed_cost_ratio(self, s: RouteState, now: float) -> float | None:
        if s.costRatioEma is None:
            return None
        if self.halfLifeMs <= 0 or s.costRatioLastAt is None:
            return s.costRatioEma
        d = math.pow(0.5, (now - s.costRatioLastAt) / self.halfLifeMs)
        return 1.0 + (s.costRatioEma - 1.0) * d

    def recordSuccess(
        self,
        routeId: str,
        latencyMs: float | None = None,
        ttfbMs: float | None = None,
        op: str = "complete",
    ) -> None:
        now = time.time() * 1000.0
        s = self._state_for(routeId, now)
        s.successes += 1
        self._decay_counts(s, now)
        s.succW += 1.0
        s.successRateEma += (1.0 - s.successRateEma) * SUCCESS_EMA_ALPHA
        op_stat = s.ops.get(op, s.ops["complete"])
        if latencyMs is not None:
            op_stat.lat.push(latencyMs, now)
        if ttfbMs is not None:
            op_stat.ttfb.push(ttfbMs, now)

    def recordFailure(
        self,
        routeId: str,
        kind: str,
        keyIndex: int | None = None,
        retryAfterMs: float | None = None,
        latencyMs: float | None = None,
        op: str = "complete",
    ) -> None:
        now = time.time() * 1000.0
        s = self._state_for(routeId, now)
        s.failures += 1
        self._decay_counts(s, now)
        s.failW += 1.0
        if kind not in s.byKind:
            s.byKind[kind] = KindTally()
        tally = s.byKind[kind]
        tally.n += 1
        tally.w += 1.0
        s.successRateEma -= s.successRateEma * SUCCESS_EMA_ALPHA

        if latencyMs is not None and kind in ("timeout", "network"):
            op_stat = s.ops.get(op, s.ops["complete"])
            op_stat.lat.push(latencyMs, now)

        if keyIndex is not None:
            if keyIndex not in s.keys:
                s.keys[keyIndex] = KeyState()
            k = s.keys[keyIndex]
            k.failures += 1
            if retryAfterMs is not None and kind in ("rate_limit", "auth", "permission"):
                k.cooldownUntil = now + min(retryAfterMs, KEY_COOLDOWN_CAP_MS)

    def recordCostRatio(self, routeId: str, ratio: float) -> None:
        now = time.time() * 1000.0
        s = self._state_for(routeId, now)
        clamped = max(0.01, min(100.0, ratio))
        self._decay_cost(s, now)
        s.costRatioEma = clamped if s.costRatioEma is None else s.costRatioEma * 0.7 + clamped * 0.3
        s.costRatioLastAt = now

    def costRatio(self, routeId: str) -> float | None:
        s = self._routes.get(routeId)
        if not s or s.costRatioEma is None:
            return None
        return self._decayed_cost_ratio(s, time.time() * 1000.0)

    def pickKey(self, routeId: str, start: int, poolSize: int) -> int | None:
        s = self._routes.get(routeId)
        now = time.time() * 1000.0
        for i in range(poolSize):
            idx = (start + i) % poolSize
            key = s.keys.get(idx) if s else None
            if not key or now >= key.cooldownUntil:
                return idx
        return None

    def keyOnCooldown(self, routeId: str, keyIndex: int) -> bool:
        s = self._routes.get(routeId)
        if not s:
            return False
        key = s.keys.get(keyIndex)
        return key is not None and key.cooldownUntil != 0 and (time.time() * 1000.0) < key.cooldownUntil

    def sampleCount(self, routeId: str, op: str | None = None) -> int:
        s = self._routes.get(routeId)
        if not s:
            return 0
        now = time.time() * 1000.0
        rings = [s.ops["complete"].lat, s.ops["stream"].lat] if op is None else [s.ops[op].lat]
        return sum(len(r.collect_within(now, self.sampleTtlMs)) for r in rings)

    def medianLatency(self, routeId: str, op: str | None = None) -> float | None:
        return self.latencyPercentile(routeId, 0.5, op)

    def latencyPercentile(self, routeId: str, p: float, op: str | None = None) -> float | None:
        s = self._routes.get(routeId)
        if not s:
            return None
        now = time.time() * 1000.0
        rings = [s.ops["complete"].lat, s.ops["stream"].lat] if op is None else [s.ops[op].lat]
        values: list[float] = []
        for r in rings:
            values.extend(r.collect_within(now, self.sampleTtlMs))
        return _percentile_of(values, p)

    def ttfbPercentile(self, routeId: str, p: float, op: str = "stream") -> float | None:
        s = self._routes.get(routeId)
        if not s:
            return None
        values = s.ops[op].ttfb.collect_within(time.time() * 1000.0, self.sampleTtlMs)
        return _percentile_of(values, p)

    def successLb(self, routeId: str) -> float | None:
        s = self._routes.get(routeId)
        if not s:
            return None
        self._decay_counts(s, time.time() * 1000.0)
        return wilson_lower_bound(s.succW, s.succW + s.failW)

    def timeoutRate(self, routeId: str) -> float | None:
        s = self._routes.get(routeId)
        if not s:
            return None
        self._decay_counts(s, time.time() * 1000.0)
        if s.failW <= 0:
            return None
        t_entry = s.byKind.get("timeout")
        tw = t_entry.w if t_entry is not None else 0.0
        return max(0.0, min(1.0, tw / s.failW))

    def snapshot(self) -> list[RouteHealthSnapshot]:
        out: list[RouteHealthSnapshot] = []
        now = time.time() * 1000.0
        for routeId, s in self._routes.items():
            by_kind = {k: v.n for k, v in s.byKind.items()}
            self._decay_counts(s, now)

            all_lat = s.ops["complete"].lat.collect_within(now, self.sampleTtlMs) + s.ops["stream"].lat.collect_within(
                now, self.sampleTtlMs
            )
            all_ttfb = s.ops["complete"].ttfb.collect_within(now, self.sampleTtlMs) + s.ops[
                "stream"
            ].ttfb.collect_within(now, self.sampleTtlMs)

            keys = [
                KeyHealth(
                    keyIndex=idx,
                    failures=k.failures,
                    cooldownRemainingMs=int(k.cooldownUntil - now) if k.cooldownUntil > now else 0,
                )
                for idx, k in s.keys.items()
            ]

            comp_lat = s.ops["complete"].lat.collect_within(now, self.sampleTtlMs)
            comp_ttfb = s.ops["complete"].ttfb.collect_within(now, self.sampleTtlMs)
            complete_view = None
            if comp_lat or comp_ttfb:
                complete_view = OpLatencyPercentiles(
                    p50Ms=_percentile_of(comp_lat, 0.5),
                    p95Ms=_percentile_of(comp_lat, 0.95),
                    p99Ms=_percentile_of(comp_lat, 0.99),
                    samples=len(comp_lat),
                )
                if comp_ttfb:
                    complete_view.ttfb = OpLatencyPercentiles(
                        p50Ms=_percentile_of(comp_ttfb, 0.5),
                        p95Ms=_percentile_of(comp_ttfb, 0.95),
                        p99Ms=_percentile_of(comp_ttfb, 0.99),
                        samples=len(comp_ttfb),
                    )

            str_lat = s.ops["stream"].lat.collect_within(now, self.sampleTtlMs)
            str_ttfb = s.ops["stream"].ttfb.collect_within(now, self.sampleTtlMs)
            stream_view = None
            if str_lat or str_ttfb:
                stream_view = OpLatencyPercentiles(
                    p50Ms=_percentile_of(str_lat, 0.5),
                    p95Ms=_percentile_of(str_lat, 0.95),
                    p99Ms=_percentile_of(str_lat, 0.99),
                    samples=len(str_lat),
                )
                if str_ttfb:
                    stream_view.ttfb = OpLatencyPercentiles(
                        p50Ms=_percentile_of(str_ttfb, 0.5),
                        p95Ms=_percentile_of(str_ttfb, 0.95),
                        p99Ms=_percentile_of(str_ttfb, 0.99),
                        samples=len(str_ttfb),
                    )

            w_lb = wilson_lower_bound(s.succW, s.succW + s.failW)
            timeout_tally = s.byKind.get("timeout")
            tr = (
                (timeout_tally.w / s.failW)
                if (s.failW > 0 and timeout_tally is not None and timeout_tally.w > 0)
                else None
            )
            cr = self._decayed_cost_ratio(s, now)

            snap = RouteHealthSnapshot(
                routeId=routeId,
                successes=s.successes,
                failures=s.failures,
                byKind=by_kind,
                successRate=round(s.successRateEma, 4),
                keys=keys,
                p50LatencyMs=_percentile_of(all_lat, 0.5),
                p95LatencyMs=_percentile_of(all_lat, 0.95),
                p99LatencyMs=_percentile_of(all_lat, 0.99),
                p50TtfbMs=_percentile_of(all_ttfb, 0.5),
                p95TtfbMs=_percentile_of(all_ttfb, 0.95),
                p99TtfbMs=_percentile_of(all_ttfb, 0.99),
                successLb=_round4(w_lb) if w_lb is not None else None,
                timeoutRate=_round4(tr) if tr is not None else None,
                complete=complete_view,
                stream=stream_view,
                costRatio=_round4(cr) if cr is not None else None,
            )
            out.append(snap)
        return out
