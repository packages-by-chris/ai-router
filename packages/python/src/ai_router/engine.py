"""Core RoutingEngine: orchestrates candidate resolution, retries, key rotation,
rate limiting, budget gating, and streaming commit boundary.
"""

from __future__ import annotations

import asyncio
import math
import random
import time
from collections.abc import AsyncIterable, Callable
from dataclasses import dataclass, field
from typing import Any

from .config.schema import (
    CircuitBreakerConfig,
    RouterConfig,
    RoutingStrategy,
)
from .errors import (
    AllRoutesFailedError,
    AttemptRecord,
    ConfigError,
    DeadlineExceededError,
    ErrorKind,
    GuardrailBlockedError,
    ProviderError,
    is_key_related_kind,
    is_retryable_kind,
)
from .guardrails import Guardrails, run_guardrails
from .limiter.memory import MemoryStore
from .limiter.store import RateLimitStore
from .providers.presets import get_preset
from .providers.registry import get_adapter
from .providers.types import (
    AdapterContext,
    NormalizedRoute,
    RawRequestOptions,
)
from .routing.capabilities import (
    CapabilityRequirement,
    capability_rejection,
)
from .routing.health import (
    HealthTracker,
    RouteHealthSnapshot,
)
from .routing.order import (
    ArrangeContext,
    ScoreBreakdown,
    arrange_chain,
    price_lookup,
)
from .routing.outcomes import OutcomeEvent, OutcomeStats, OutcomeTracker
from .routing.state import RouterStateStore, infer_task
from .types import (
    ChatChunk,
    ChatRequest,
    ChatResponse,
    EmbeddingRequest,
    EmbeddingResponse,
    TokenPrice,
    Usage,
)

DEFAULT_MAX_RETRIES = 2
DEFAULT_TIMEOUT_MS = 30_000
WINDOW_MS = 60_000
BACKOFF_BASE_MS = 400
BACKOFF_CAP_MS = 8_000
BACKOFF_JITTER = 0.25


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
                    tc_fn = getattr(tc, "function", None) if not isinstance(tc, dict) else tc.get("function")
                    if isinstance(tc_fn, dict):
                        chars += len(tc_fn.get("name", "")) + len(str(tc_fn.get("arguments", "")))
    return max(1, math.ceil(chars / 4))


def compute_cost(usage: Usage, price: TokenPrice) -> float:
    cost = (usage.prompt_tokens * price.input_usd) / 1_000_000.0
    cost += (usage.completion_tokens * price.output_usd) / 1_000_000.0
    if usage.cached_tokens and price.cached_usd:
        cost += (usage.cached_tokens * price.cached_usd) / 1_000_000.0
    return cost


@dataclass
class RouteView:
    id: str
    provider: str
    model: str
    weight: float | None = None
    capabilities: Any = None


@dataclass
class RoutingOptions:
    require: CapabilityRequirement | None = None
    task: str | None = None
    filter: Callable[[RouteView], bool] | None = None
    maxCostUsd: float | None = None
    maxLatencyMs: float | None = None


@dataclass
class AttemptEvent:
    routeId: str
    provider: str
    model: str
    outcome: str
    attempts: int
    keyIndex: int | None = None
    kind: ErrorKind | None = None
    message: str | None = None
    durationMs: float | None = None
    latencyMs: float | None = None
    status: int | None = None


@dataclass
class CallSummaryEvent:
    routeId: str
    provider: str
    model: str
    attempts: list[AttemptEvent]
    totalAttempts: int
    durationMs: float
    usage: Usage | None = None
    costUsd: float | None = None


@dataclass
class CallOptions:
    onAttempt: Callable[[AttemptEvent], None] | None = None
    onFinish: Callable[[CallSummaryEvent], None] | None = None
    onLog: Callable[[dict[str, Any]], None] | None = None
    deadlineMs: int | None = None
    routing: RoutingOptions | None = None
    signal: Any = None


@dataclass
class CandidateExplanation:
    routeId: str
    provider: str
    model: str
    status: str  # "selected" | "rejected" | "backup"
    reasons: list[str]
    estimatedCostUsd: float | None = None
    observedLatencyMs: float | None = None
    observedTtfbMs: float | None = None
    score: float | None = None
    scoreBreakdown: ScoreBreakdown | None = None


@dataclass
class RoutingExplanation:
    model: str
    target_id: str | None = None
    strategy: RoutingStrategy = "fallback"
    candidates: list[CandidateExplanation] = field(default_factory=list)
    selected: CandidateExplanation | None = None
    task: str | None = None

    def __post_init__(self) -> None:
        if self.target_id is None and self.model:
            self.target_id = self.model


@dataclass
class RouterStats:
    strategy: RoutingStrategy
    circuitBreakers: list[dict[str, Any]]
    keyCursors: dict[str, int]
    latencies: dict[str, float]
    rateLimits: dict[str, float] | None
    health: list[RouteHealthSnapshot]
    outcomes: list[OutcomeStats]


class RoutingEngine:
    def __init__(
        self,
        config: RouterConfig | dict[str, Any],
        store: RateLimitStore | None = None,
        pricing: dict[str, TokenPrice] | None = None,
        circuit_breaker: CircuitBreakerConfig | dict[str, Any] | None = None,
        guardrails: Guardrails | None = None,
        auto_task: bool = False,
        state_store: RouterStateStore | None = None,
        fetch_impl: Any = None,
        sleep: Any = None,
        rng: Any = None,
        middleware: Any = None,
        circuitBreaker: CircuitBreakerConfig | dict[str, Any] | None = None,
    ) -> None:
        self.config = config if isinstance(config, RouterConfig) else RouterConfig(**config)
        self.store: RateLimitStore = store or MemoryStore()
        self.pricing = pricing
        self.guardrails = guardrails
        self.auto_task = auto_task
        self.state_store = state_store
        self.fetch_impl = fetch_impl
        self.sleep = sleep
        self.rng = rng
        self.middleware = middleware

        cb_arg = circuit_breaker if circuit_breaker is not None else circuitBreaker
        cb: dict[str, Any] = {}
        if isinstance(cb_arg, CircuitBreakerConfig):
            cb = cb_arg.to_dict()
        elif isinstance(cb_arg, dict):
            cb = cb_arg

        self.cb_threshold = cb.get("threshold", 5)
        self.cb_cooldown_ms = cb.get("cooldownMs", cb.get("cooldown_ms", 30_000))
        self.cb_max_cooldown_ms = cb.get("maxCooldownMs", cb.get("max_cooldown_ms", self.cb_cooldown_ms))

        self._cb_state: dict[str, dict[str, Any]] = {}
        self._key_cursors: dict[str, int] = {}
        self._rr_counter = 0

        self.health = HealthTracker()
        self.outcomes = OutcomeTracker()

        # Normalize routes
        self.normalized_routes: list[NormalizedRoute] = []
        for r in self.config.routes:
            preset = get_preset(r.provider)
            key_pool = r.apiKeys or ([r.apiKey] if r.apiKey else [])
            auth_header_name = None
            if preset and isinstance(preset.auth, dict) and "header" in preset.auth:
                auth_header_name = preset.auth["header"]

            nr = NormalizedRoute(
                id=r.id,
                provider=r.provider,
                model=r.model,
                apiKey=r.apiKey,
                apiKeys=r.apiKeys,
                baseUrl=r.baseUrl or (preset.baseUrl if preset else None),
                apiVersion=r.apiVersion,
                region=r.region,
                project=r.project,
                headers=dict(r.headers or (preset.headers if preset and preset.headers else {})),
                maxRetries=r.maxRetries if r.maxRetries is not None else DEFAULT_MAX_RETRIES,
                timeoutMs=r.timeoutMs or DEFAULT_TIMEOUT_MS,
                streamIdleTimeoutMs=r.streamIdleTimeoutMs,
                limit=r.limit,
                budget=r.budget,
                weight=r.weight,
                capabilities=r.capabilities,
                adapterId=preset.adapter if preset else r.provider,
                authHeaderName=auth_header_name,
                keyPool=list(key_pool),
            )
            self.normalized_routes.append(nr)

    def _resolve_chain(self, route_id: str) -> list[NormalizedRoute]:
        for i, r in enumerate(self.normalized_routes):
            if r.id == route_id:
                return list(self.normalized_routes[i:])
        raise ConfigError(f'unknown route id: "{route_id}"')

    def _is_cb_open(self, route_id: str, now: float | None = None, for_explain: bool = False) -> bool:
        current_time = now if now is not None else time.time() * 1000.0
        cb = self._cb_state.get(route_id)
        if not cb:
            return False
        open_until = cb.get("openUntil", 0)
        if current_time < open_until:
            return True
        if open_until > 0:
            if for_explain:
                return bool(cb.get("probing", False))
            if cb.get("probing", False):
                return True
            cb["probing"] = True
            return False
        return False

    async def complete(
        self,
        req: ChatRequest | dict[str, Any],
        options: CallOptions | None = None,
        *,
        on_attempt: Callable[[AttemptEvent], None] | None = None,
        on_finish: Callable[[CallSummaryEvent], None] | None = None,
        deadline_ms: int | None = None,
        signal: Any = None,
    ) -> ChatResponse:
        opts = options or CallOptions()
        if on_attempt is not None:
            opts.onAttempt = on_attempt
        if on_finish is not None:
            opts.onFinish = on_finish
        if deadline_ms is not None:
            opts.deadlineMs = deadline_ms
        if signal is not None:
            opts.signal = signal

        req_obj = (
            req
            if isinstance(req, ChatRequest)
            else ChatRequest(**{k: v for k, v in req.items() if k in ChatRequest.__dataclass_fields__})
        )

        # Run input guardrails
        if self.guardrails and self.guardrails.input:
            req_obj = await run_guardrails("input", self.guardrails.input, req_obj)

        chain = self._resolve_chain(req_obj.model)
        start_time = time.time() * 1000.0
        deadline_at = (start_time + opts.deadlineMs) if opts.deadlineMs else None

        task = (opts.routing.task if opts.routing else None) or (infer_task(req_obj) if self.auto_task else None)

        counter = self._rr_counter
        self._rr_counter += 1

        arranged = arrange_chain(
            ArrangeContext(
                strategy=self.config.strategy,
                op="complete",
                rng=self.rng or random.random,
                rrCounter=counter,
                health=self.health,
                outcomes=self.outcomes,
                estimateTokensFn=_estimate_tokens,
                req=req_obj,
                chain=chain,
                task=task,
                pricing=self.pricing,
                weights=self.config.weights,
            )
        )

        attempts: list[AttemptRecord] = []

        for route in arranged.chain:
            # Check deadline
            if deadline_at and time.time() * 1000.0 >= deadline_at:
                raise DeadlineExceededError(opts.deadlineMs or 0)

            # Circuit breaker check
            if self._is_cb_open(route.id):
                attempts.append(
                    AttemptRecord(
                        route_id=route.id,
                        provider=route.provider,
                        model=route.model,
                        outcome="circuit_open",
                        attempts=0,
                    )
                )
                if opts.onAttempt:
                    opts.onAttempt(
                        AttemptEvent(
                            routeId=route.id,
                            provider=route.provider,
                            model=route.model,
                            outcome="circuit_open",
                            attempts=0,
                        )
                    )
                continue

            # Check custom filter
            if opts.routing and opts.routing.filter:
                view = RouteView(
                    id=route.id,
                    provider=route.provider,
                    model=route.model,
                    weight=route.weight,
                    capabilities=route.capabilities,
                )
                if not opts.routing.filter(view):
                    attempts.append(
                        AttemptRecord(
                            route_id=route.id,
                            provider=route.provider,
                            model=route.model,
                            outcome="error",
                            attempts=0,
                            message="filtered by custom rule",
                        )
                    )
                    continue

            # Capabilities check
            cap_rej = capability_rejection(
                route.capabilities,
                req_obj,
                "complete",
                opts.routing.require if opts.routing else None,
                _estimate_tokens(req_obj),
            )
            if cap_rej:
                attempts.append(
                    AttemptRecord(
                        route_id=route.id,
                        provider=route.provider,
                        model=route.model,
                        outcome="capability_mismatch",
                        attempts=0,
                        message=cap_rej,
                    )
                )
                if opts.onAttempt:
                    opts.onAttempt(
                        AttemptEvent(
                            routeId=route.id,
                            provider=route.provider,
                            model=route.model,
                            outcome="capability_mismatch",
                            attempts=0,
                            message=cap_rej,
                        )
                    )
                continue

            # Rate limit pre-flight
            if route.limit and route.limit.rpm:
                dec = await self.store.take(f"rl:{route.id}:rpm", 1, WINDOW_MS, route.limit.rpm)
                if not dec.allowed:
                    attempts.append(
                        AttemptRecord(
                            route_id=route.id,
                            provider=route.provider,
                            model=route.model,
                            outcome="skipped_rate_limit",
                            attempts=0,
                            retry_after_ms=dec.retryAfterMs,
                        )
                    )
                    if opts.onAttempt:
                        opts.onAttempt(
                            AttemptEvent(
                                routeId=route.id,
                                provider=route.provider,
                                model=route.model,
                                outcome="skipped_rate_limit",
                                attempts=0,
                            )
                        )
                    continue

            # Budget check
            if route.budget:
                win_ms = route.budget.windowMs or WINDOW_MS
                spent = self.store.used(f"budget:{route.id}", win_ms)
                if spent >= route.budget.usd:
                    attempts.append(
                        AttemptRecord(
                            route_id=route.id,
                            provider=route.provider,
                            model=route.model,
                            outcome="skipped_budget",
                            attempts=0,
                        )
                    )
                    if opts.onAttempt:
                        opts.onAttempt(
                            AttemptEvent(
                                routeId=route.id,
                                provider=route.provider,
                                model=route.model,
                                outcome="skipped_budget",
                                attempts=0,
                            )
                        )
                    continue

            # Key selection
            pool_size = max(1, len(route.keyPool))
            cursor = self._key_cursors.get(route.id, 0)
            key_idx = self.health.pickKey(route.id, cursor, pool_size)
            if key_idx is None:
                key_idx = cursor % pool_size
            self._key_cursors[route.id] = (key_idx + 1) % pool_size

            key = route.keyPool[key_idx] if route.keyPool else ""
            adapter = get_adapter(route.adapterId or route.provider)

            tries = 0
            retries = 0
            keys_exhausted = 0
            max_retries = route.maxRetries

            while True:
                tries += 1
                try:
                    call_start = time.time() * 1000.0
                    ctx = AdapterContext(signal=getattr(opts, "signal", None), fetch=self.fetch_impl)
                    resp = await adapter.complete(route, key, req_obj, ctx)
                    call_duration = time.time() * 1000.0 - call_start

                    # Record health & clear circuit breaker
                    self.health.recordSuccess(route.id, latencyMs=call_duration, op="complete")
                    if route.id in self._cb_state:
                        del self._cb_state[route.id]

                    # Account TPM and Budget
                    if resp.usage:
                        if route.limit and route.limit.tpm:
                            await self.store.record(f"rl:{route.id}:tpm", resp.usage.total_tokens, WINDOW_MS)
                        price = price_lookup(self.pricing, route.id, route.model)
                        if price:
                            cost = compute_cost(resp.usage, price)
                            resp.cost_usd = cost
                            if route.budget:
                                win_ms = route.budget.windowMs or WINDOW_MS
                                await self.store.record(f"budget:{route.id}", int(cost * 1e6), win_ms)

                    # Output guardrails
                    if self.guardrails and self.guardrails.output:
                        resp = await run_guardrails("output", self.guardrails.output, resp)

                    if opts.onAttempt:
                        opts.onAttempt(
                            AttemptEvent(
                                routeId=route.id,
                                provider=route.provider,
                                model=route.model,
                                outcome="ok",
                                attempts=tries,
                                keyIndex=key_idx,
                                durationMs=call_duration,
                                latencyMs=call_duration,
                                status=200,
                            )
                        )

                    if opts.onFinish:
                        opts.onFinish(
                            CallSummaryEvent(
                                routeId=route.id,
                                provider=route.provider,
                                model=route.model,
                                attempts=[],
                                totalAttempts=tries,
                                durationMs=time.time() * 1000.0 - start_time,
                                usage=resp.usage,
                                costUsd=resp.cost_usd,
                            )
                        )

                    return resp
                except Exception as err:
                    if isinstance(err, GuardrailBlockedError):
                        raise

                    kind: ErrorKind = getattr(err, "kind", "unknown") if isinstance(err, ProviderError) else "network"
                    retry_after = (
                        getattr(err, "retry_after_ms", None)
                        if isinstance(err, ProviderError) and getattr(err, "retry_after_ms", None) is not None
                        else (getattr(err, "retryAfterMs", None) if isinstance(err, ProviderError) else None)
                    )
                    status_code = getattr(err, "status", None) if isinstance(err, ProviderError) else None

                    self.health.recordFailure(route.id, kind, keyIndex=key_idx, retryAfterMs=retry_after, op="complete")

                    # Update circuit breaker
                    now_ms = time.time() * 1000.0
                    cb_info = self._cb_state.get(route.id, {"failures": 0, "openUntil": 0, "opens": 0})
                    if cb_info.get("probing") or (cb_info.get("openUntil", 0) > 0 and now_ms >= cb_info.get("openUntil", 0)):
                        cb_info["probing"] = False
                        cb_info["opens"] = cb_info.get("opens", 0) + 1
                        cooldown = min(self.cb_max_cooldown_ms, self.cb_cooldown_ms * (2 ** (cb_info["opens"] - 1)))
                        cb_info["openUntil"] = now_ms + cooldown
                        cb_info["failures"] = self.cb_threshold
                    else:
                        cb_info["failures"] = cb_info.get("failures", 0) + 1
                        if cb_info["failures"] >= self.cb_threshold and cb_info.get("openUntil", 0) == 0:
                            cb_info["opens"] = cb_info.get("opens", 0) + 1
                            cooldown = min(self.cb_max_cooldown_ms, self.cb_cooldown_ms * (2 ** (cb_info["opens"] - 1)))
                            cb_info["openUntil"] = now_ms + cooldown
                    self._cb_state[route.id] = cb_info

                    if is_key_related_kind(kind) and pool_size > 1:
                        keys_exhausted += 1
                        if keys_exhausted < pool_size:
                            prev_key = key_idx
                            key_idx = (key_idx + 1) % pool_size
                            key = route.keyPool[key_idx]
                            if opts.onAttempt:
                                opts.onAttempt(
                                    AttemptEvent(
                                        routeId=route.id,
                                        provider=route.provider,
                                        model=route.model,
                                        outcome="retry",
                                        attempts=tries,
                                        keyIndex=prev_key,
                                        kind=kind,
                                        message=str(err),
                                        status=status_code,
                                    )
                                )
                            continue

                    if not is_retryable_kind(kind):
                        attempts.append(
                            AttemptRecord(
                                route_id=route.id,
                                provider=route.provider,
                                model=route.model,
                                outcome="error",
                                attempts=tries,
                                key_index=key_idx,
                                kind=kind,
                                message=str(err),
                                retry_after_ms=retry_after,
                            )
                        )
                        break

                    if retries < max_retries:
                        retries += 1
                        if opts.onAttempt:
                            opts.onAttempt(
                                AttemptEvent(
                                    routeId=route.id,
                                    provider=route.provider,
                                    model=route.model,
                                    outcome="retry",
                                    attempts=tries,
                                    keyIndex=key_idx,
                                    kind=kind,
                                    message=str(err),
                                    status=status_code,
                                )
                            )
                        backoff = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2 ** (retries - 1)))
                        if retry_after is not None and retry_after > backoff:
                            backoff = retry_after
                        if self.sleep:
                            res_sleep = self.sleep(backoff)
                            if hasattr(res_sleep, "__await__"):
                                await res_sleep
                        else:
                            await asyncio.sleep(backoff / 1000.0)
                        continue

                    if opts.onAttempt:
                        opts.onAttempt(
                            AttemptEvent(
                                routeId=route.id,
                                provider=route.provider,
                                model=route.model,
                                outcome="error",
                                attempts=tries,
                                keyIndex=key_idx,
                                kind=kind,
                                message=str(err),
                                status=status_code,
                            )
                        )

                    attempts.append(
                        AttemptRecord(
                            route_id=route.id,
                            provider=route.provider,
                            model=route.model,
                            outcome="error",
                            attempts=tries,
                            key_index=key_idx,
                            kind=kind,
                            message=str(err),
                            retry_after_ms=retry_after,
                        )
                    )
                    break

        raise AllRoutesFailedError(attempts)

    async def stream(
        self,
        req: ChatRequest | dict[str, Any],
        options: CallOptions | None = None,
        *,
        on_attempt: Callable[[AttemptEvent], None] | None = None,
        on_finish: Callable[[CallSummaryEvent], None] | None = None,
    ) -> AsyncIterable[ChatChunk]:
        opts = options or CallOptions()
        if on_attempt is not None:
            opts.onAttempt = on_attempt
        if on_finish is not None:
            opts.onFinish = on_finish

        req_obj = (
            req
            if isinstance(req, ChatRequest)
            else ChatRequest(**{k: v for k, v in req.items() if k in ChatRequest.__dataclass_fields__})
        )

        if self.guardrails and self.guardrails.input:
            req_obj = await run_guardrails("input", self.guardrails.input, req_obj)

        chain = self._resolve_chain(req_obj.model)
        task = (opts.routing.task if opts.routing else None) or (infer_task(req_obj) if self.auto_task else None)

        counter = self._rr_counter
        self._rr_counter += 1

        arranged = arrange_chain(
            ArrangeContext(
                strategy=self.config.strategy,
                op="stream",
                rng=self.rng or random.random,
                rrCounter=counter,
                health=self.health,
                outcomes=self.outcomes,
                estimateTokensFn=_estimate_tokens,
                req=req_obj,
                chain=chain,
                task=task,
                pricing=self.pricing,
                weights=self.config.weights,
            )
        )

        attempts: list[AttemptRecord] = []

        for route in arranged.chain:
            pool_size = max(1, len(route.keyPool))
            cursor = self._key_cursors.get(route.id, 0)
            key_idx = self.health.pickKey(route.id, cursor, pool_size)
            if key_idx is None:
                key_idx = cursor % pool_size
            self._key_cursors[route.id] = (key_idx + 1) % pool_size
            key = route.keyPool[key_idx] if route.keyPool else ""

            adapter = get_adapter(route.adapterId or route.provider)
            try:
                ctx = AdapterContext(signal=getattr(opts, "signal", None), fetch=self.fetch_impl)
                stream_iter = await adapter.stream(route, key, req_obj, ctx)

                async def stream_wrapper():
                    committed = False
                    first_chunk_time = None
                    call_start = time.time() * 1000.0
                    try:
                        async for chunk in stream_iter:
                            if not committed:
                                committed = True
                                first_chunk_time = time.time() * 1000.0 - call_start
                                self.health.recordSuccess(route.id, ttfbMs=first_chunk_time, op="stream")
                            yield chunk
                    except Exception:
                        if not committed:
                            raise
                        # mid-stream error
                        raise

                return stream_wrapper()
            except Exception as err:
                attempts.append(
                    AttemptRecord(
                        route_id=route.id,
                        provider=route.provider,
                        model=route.model,
                        outcome="error",
                        attempts=1,
                        message=str(err),
                    )
                )
                continue

        raise AllRoutesFailedError(attempts)

    async def raw(
        self,
        route_id: str,
        opts: RawRequestOptions | dict[str, Any],
    ) -> Any:
        options = opts if isinstance(opts, RawRequestOptions) else RawRequestOptions(**opts)
        chain = self._resolve_chain(route_id)
        route = chain[0]
        key = route.keyPool[0] if route.keyPool else ""
        adapter = get_adapter(route.adapterId or route.provider)
        ctx = AdapterContext(fetch=self.fetch_impl)
        return await adapter.raw(route, key, options, ctx)

    async def embed(
        self,
        req: EmbeddingRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> EmbeddingResponse:
        opts = options or CallOptions()
        req_obj = (
            req
            if isinstance(req, EmbeddingRequest)
            else EmbeddingRequest(**{k: v for k, v in req.items() if k in EmbeddingRequest.__dataclass_fields__})
        )
        chain = self._resolve_chain(req_obj.model)
        route = chain[0]
        key = route.keyPool[0] if route.keyPool else ""
        adapter = get_adapter(route.adapterId or route.provider)
        ctx = AdapterContext(signal=getattr(opts, "signal", None), fetch=self.fetch_impl)
        return await adapter.embed(route, key, req_obj, ctx)

    def explain(
        self,
        req: ChatRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> RoutingExplanation:
        opts = options or CallOptions()
        req_obj = (
            req
            if isinstance(req, ChatRequest)
            else ChatRequest(**{k: v for k, v in req.items() if k in ChatRequest.__dataclass_fields__})
        )
        chain = self._resolve_chain(req_obj.model)
        task = (opts.routing.task if opts.routing else None) or (infer_task(req_obj) if self.auto_task else None)

        arranged = arrange_chain(
            ArrangeContext(
                strategy=self.config.strategy,
                op="complete",
                rng=self.rng or random.random,
                rrCounter=self._rr_counter,
                health=self.health,
                outcomes=self.outcomes,
                estimateTokensFn=_estimate_tokens,
                req=req_obj,
                chain=chain,
                task=task,
                pricing=self.pricing,
                weights=self.config.weights,
            )
        )

        candidates: list[CandidateExplanation] = []
        selected_candidate: CandidateExplanation | None = None

        for r in arranged.chain:
            entry = CandidateExplanation(
                routeId=r.id,
                provider=r.provider,
                model=r.model,
                status="backup",
                reasons=[],
            )
            candidates.append(entry)

            if selected_candidate is not None:
                continue

            # 1. Circuit breaker
            if self._is_cb_open(r.id, for_explain=True):
                entry.status = "rejected"
                entry.reasons.append("circuit breaker open")
                continue

            # 2. Capabilities & Constraints
            cap_rej = capability_rejection(
                r.capabilities,
                req_obj,
                "complete",
                opts.routing.require if opts.routing else None,
                _estimate_tokens(req_obj),
            )
            if cap_rej:
                entry.status = "rejected"
                entry.reasons.append(cap_rej)
                continue

            # 3. Budget
            if r.budget:
                win_ms = r.budget.windowMs or WINDOW_MS
                spent = self.store.used(f"budget:{r.id}", win_ms)
                if spent >= r.budget.usd:
                    entry.status = "rejected"
                    entry.reasons.append("usd spend budget exhausted")
                    continue

            # First eligible candidate is selected
            entry.status = "selected"
            entry.reasons.append("highest ranking candidate")
            selected_candidate = entry

        return RoutingExplanation(
            model=req_obj.model,
            target_id=req_obj.model,
            strategy=self.config.strategy or "fallback",
            candidates=candidates,
            selected=selected_candidate,
            task=task,
        )

    def record_outcome(self, event: OutcomeEvent | dict[str, Any]) -> None:
        ev = event if isinstance(event, OutcomeEvent) else OutcomeEvent(**event)
        self.outcomes.record(ev)

    def stats(self) -> RouterStats:
        return RouterStats(
            strategy=self.config.strategy or "fallback",
            circuitBreakers=[{"routeId": k, **v} for k, v in self._cb_state.items()],
            keyCursors=dict(self._key_cursors),
            latencies={},
            rateLimits=None,
            health=self.health.snapshot(),
            outcomes=self.outcomes.snapshot(),
        )
