"""Provider adapter types and protocols."""

from __future__ import annotations

from collections.abc import AsyncIterable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from ..config.schema import ModelRoute
from ..types import (
    ChatChunk,
    ChatRequest,
    ChatResponse,
    EmbeddingRequest,
    EmbeddingResponse,
)


@dataclass
class NormalizedRoute(ModelRoute):
    adapterId: str | None = None
    authHeaderName: str | None = None
    keyPool: list[str] = field(default_factory=list)
    limits: dict[str, int] = field(default_factory=dict)


@dataclass
class AdapterContext:
    signal: Any = None
    fetch: Any = None


@dataclass
class RawRequestOptions:
    path: str | None = None
    body: Any = None
    headers: dict[str, str] | None = None
    method: str = "POST"
    signal: Any = None


@runtime_checkable
class ProviderAdapter(Protocol):
    @property
    def id(self) -> str: ...

    async def complete(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> ChatResponse: ...

    async def stream(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> AsyncIterable[ChatChunk]: ...

    async def raw(
        self,
        route: NormalizedRoute,
        key: str,
        opts: RawRequestOptions,
        ctx: AdapterContext | None = None,
    ) -> Any: ...

    async def embed(
        self,
        route: NormalizedRoute,
        key: str,
        req: EmbeddingRequest,
        ctx: AdapterContext | None = None,
    ) -> EmbeddingResponse: ...
