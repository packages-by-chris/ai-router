"""Offline strategy replay: simulate strategy decisions over recorded event logs."""

from __future__ import annotations

import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from ..config.schema import ModelRoute, RouterConfig, RoutingStrategy
from .health import (
    DEFAULT_HALF_LIFE_MS,
    DEFAULT_SAMPLE_TTL_MS,
    HealthTracker,
    RouteHealthSnapshot,
    RouteOpStat,
)
from .order import arrange_chain
from .outcomes import OutcomeStats, OutcomeTracker


def _estimate_tokens(req: Any) -> int:
    chars = 0
    messages = getattr(req, "messages", None) if not isinstance(req, dict) else req.get("messages")
    if messages:
        for msg in messages:
            chars += 4
            content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
            if isinstance(content, str):
                chars += len(content)
            elif isinstance(content, list):
                for part in content:
                    p_type = getattr(part, "type", None) if not isinstance(part, dict) else part.get("type")
                    if p_type == "text":
                        text = getattr(part, "text", "") if not isinstance(part, dict) else part.get("text", "")
                        chars += len(text)
                    else:
                        chars += 1000
            tool_calls = getattr(msg, "tool_calls", None) if not isinstance(msg, dict) else msg.get("tool_calls")
            if tool_calls:
                for tc in tool_calls:
                    fn = getattr(tc, "function", None) if not isinstance(tc, dict) else tc.get("function")
                    name = getattr(fn, "name", "") if not isinstance(fn, dict) else fn.get("name", "")
                    args = getattr(fn, "arguments", "") if not isinstance(fn, dict) else fn.get("arguments", "")
                    chars += len(name) + len(args) + 20

    tools = getattr(req, "tools", None) if not isinstance(req, dict) else req.get("tools")
    if tools:
        for tool in tools:
            fn = getattr(tool, "function", None) if not isinstance(tool, dict) else tool.get("function")
            name = getattr(fn, "name", "") if not isinstance(fn, dict) else fn.get("name", "")
            desc = getattr(fn, "description", None) if not isinstance(fn, dict) else fn.get("description")
            chars += len(name) + (len(desc) if desc else 0) + 100

    return int((chars + 3.4) // 3.5) + 1


@dataclass
class ReplayRequest:
    model: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None = None
    max_tokens: int | None = None


@dataclass
class ReplayEvent:
    request: ReplayRequest | dict[str, Any]
    servedRouteId: str | None = None
    success: bool | None = None
    quality: float | None = None
    latencyMs: float | None = None
    costUsd: float | None = None
    op: RouteOpStat = "complete"


@dataclass
class ReplayOptions:
    rng: Callable[[], float] | None = None
    halfLifeMs: int = DEFAULT_HALF_LIFE_MS
    sampleTtlMs: int = DEFAULT_SAMPLE_TTL_MS
    emaAlpha: float = 0.3
    pricing: dict[str, Any] | None = None


@dataclass
class ReplayResult:
    chosen: list[str]
    orders: list[list[str]]
    health: list[RouteHealthSnapshot]
    outcomes: list[OutcomeStats]


def replay_strategy(
    config: RouterConfig | dict[str, Any],
    strategy: RoutingStrategy | None,
    events: Sequence[ReplayEvent | dict[str, Any]],
    opts: ReplayOptions | None = None,
) -> ReplayResult:
    """Replays events through strategy and reports route choices."""
    options = opts or ReplayOptions()
    health = HealthTracker(halfLifeMs=options.halfLifeMs, sampleTtlMs=options.sampleTtlMs)
    outcomes = OutcomeTracker(alpha=options.emaAlpha, halfLifeMs=options.halfLifeMs)
    rng = options.rng or random.random
    rr_counter = 0

    routes = config.routes if isinstance(config, RouterConfig) else config.get("routes", [])
    weights = config.weights if isinstance(config, RouterConfig) else config.get("weights")

    chosen: list[str] = []
    orders: list[list[str]] = []

    for ev_raw in events:
        ev = ReplayEvent(**ev_raw) if isinstance(ev_raw, dict) else ev_raw
        req = ev.request
        model_name = req.model if isinstance(req, ReplayRequest) else req.get("model", "")

        target_idx = -1
        for i, r in enumerate(routes):
            r_id = (
                r.id if isinstance(r, ModelRoute) else (r.get("id") if isinstance(r, dict) else getattr(r, "id", None))
            )
            if r_id == model_name:
                target_idx = i
                break

        if target_idx == -1:
            chosen.append("")
            orders.append([])
            continue

        chain = list(routes[target_idx:])
        counter = rr_counter if strategy == "round-robin" and len(chain) > 1 else 0
        if strategy == "round-robin" and len(chain) > 1:
            rr_counter += 1

        from ..providers.types import NormalizedRoute
        from .order import ArrangeContext

        norm_chain = [
            r
            if isinstance(r, NormalizedRoute)
            else NormalizedRoute(
                id=r.id if isinstance(r, ModelRoute) else (r["id"] if isinstance(r, dict) else getattr(r, "id")),
                provider=r.provider
                if isinstance(r, ModelRoute)
                else (r["provider"] if isinstance(r, dict) else getattr(r, "provider")),
                model=r.model
                if isinstance(r, ModelRoute)
                else (r["model"] if isinstance(r, dict) else getattr(r, "model")),
                weight=r.weight
                if isinstance(r, ModelRoute)
                else (r.get("weight") if isinstance(r, dict) else getattr(r, "weight", None)),
            )
            for r in chain
        ]

        result = arrange_chain(
            ArrangeContext(
                strategy=strategy,
                op=ev.op,
                task=None,
                rng=rng,
                rrCounter=counter,
                health=health,
                outcomes=outcomes,
                estimateTokensFn=_estimate_tokens,
                weights=weights,
                pricing=options.pricing,
                req=req,
                chain=norm_chain,
            )
        )

        order_ids = [r.id for r in result.chain]
        orders.append(order_ids)
        first_choice = order_ids[0] if order_ids else ""
        chosen.append(first_choice)

        served_id = ev.servedRouteId or first_choice
        if not served_id:
            continue

        if ev.quality is not None or ev.success is not None or ev.costUsd is not None:
            outcomes.record(
                {
                    "routeId": served_id,
                    "quality": ev.quality,
                    "success": True if ev.success is None else ev.success,
                    "latencyMs": ev.latencyMs,
                    "costUsd": ev.costUsd,
                }
            )

        if ev.latencyMs is not None:
            op = ev.op or "complete"
            if ev.success is False:
                health.recordFailure(served_id, "timeout", latencyMs=ev.latencyMs, op=op)
            elif op == "stream":
                health.recordSuccess(served_id, ttfbMs=ev.latencyMs, op=op)
            else:
                health.recordSuccess(served_id, latencyMs=ev.latencyMs, op=op)

    return ReplayResult(
        chosen=chosen,
        orders=orders,
        health=health.snapshot(),
        outcomes=outcomes.snapshot(),
    )
