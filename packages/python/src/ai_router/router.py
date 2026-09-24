"""Public AIRouter facade for Python."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterable, Iterable
from typing import Any

from .config.parse import parse_config
from .config.schema import CircuitBreakerConfig, RouterConfig
from .engine import (
    CallOptions,
    RateLimitStore,
    RouterStats,
    RoutingEngine,
    RoutingExplanation,
)
from .guardrails import Guardrails
from .providers.types import RawRequestOptions
from .routing.outcomes import OutcomeEvent
from .routing.state import RouterStateStore
from .types import (
    ChatChunk,
    ChatRequest,
    ChatResponse,
    EmbeddingRequest,
    EmbeddingResponse,
    TokenPrice,
)


def _run_sync(coro: Any) -> Any:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None and loop.is_running():
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            return executor.submit(lambda: asyncio.run(coro)).result()
    else:
        return asyncio.run(coro)


class AIRouter:
    """The main client-side LLM router."""

    def __init__(
        self,
        config: RouterConfig | dict[str, Any] | str,
        *,
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
        env: dict[str, str] | None = None,
        circuitBreaker: CircuitBreakerConfig | dict[str, Any] | None = None,
    ) -> None:
        if isinstance(config, RouterConfig):
            self.config = config
        else:
            self.config = parse_config(config, env=env)

        self.engine = RoutingEngine(
            config=self.config,
            store=store,
            pricing=pricing,
            circuit_breaker=circuit_breaker if circuit_breaker is not None else circuitBreaker,
            guardrails=guardrails,
            auto_task=auto_task,
            state_store=state_store,
            fetch_impl=fetch_impl,
            sleep=sleep,
            rng=rng,
            middleware=middleware,
        )

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> AIRouter:
        """Construct AIRouter from AI_ROUTER_CONFIG environment variable."""
        env_map = env or dict(os.environ)
        raw = env_map.get("AI_ROUTER_CONFIG")
        if not raw:
            raise ValueError("AI_ROUTER_CONFIG environment variable is not set")
        return cls(raw, env=env_map)

    # Async methods (primary)
    async def complete(
        self,
        req: ChatRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> ChatResponse:
        return await self.engine.complete(req, options)

    async def stream(
        self,
        req: ChatRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> AsyncIterable[ChatChunk]:
        return await self.engine.stream(req, options)

    async def raw(
        self,
        route_id: str,
        opts: RawRequestOptions | dict[str, Any],
    ) -> Any:
        return await self.engine.raw(route_id, opts)

    async def embed(
        self,
        req: EmbeddingRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> EmbeddingResponse:
        return await self.engine.embed(req, options)

    # Aliases
    acomplete = complete
    astream = stream
    araw = raw
    aembed = embed

    # Sync methods
    def complete_sync(
        self,
        req: ChatRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> ChatResponse:
        return _run_sync(self.complete(req, options))

    def stream_sync(
        self,
        req: ChatRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> Iterable[ChatChunk]:
        async def _collect() -> list[ChatChunk]:
            aiter = (await self.stream(req, options)).__aiter__()
            chunks = []
            async for c in aiter:
                chunks.append(c)
            return chunks

        chunks = _run_sync(_collect())
        yield from chunks

    def raw_sync(
        self,
        route_id: str,
        opts: RawRequestOptions | dict[str, Any],
    ) -> Any:
        return _run_sync(self.raw(route_id, opts))

    def embed_sync(
        self,
        req: EmbeddingRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> EmbeddingResponse:
        return _run_sync(self.embed(req, options))

    def explain(
        self,
        req: ChatRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> RoutingExplanation:
        return self.engine.explain(req, options)

    def explain_sync(
        self,
        req: ChatRequest | dict[str, Any],
        options: CallOptions | None = None,
    ) -> RoutingExplanation:
        return self.engine.explain(req, options)

    def record_outcome(self, event: OutcomeEvent | dict[str, Any]) -> None:
        self.engine.record_outcome(event)

    def record_outcome_sync(self, event: OutcomeEvent | dict[str, Any]) -> None:
        self.engine.record_outcome(event)

    def stats(self) -> RouterStats:
        return self.engine.stats()
