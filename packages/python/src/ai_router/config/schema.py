"""JSON-serializable router config schema.

This shape is the cross-language contract: the TypeScript and Python SDKs
validate against the same schema and conformance fixtures.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

PROVIDER_IDS = (
    "openai",
    "openai-compatible",
    "azure",
    "anthropic",
    "gemini",
    "bedrock",
    "vertex",
)

ProviderId = str

RoutingStrategy = Literal[
    "fallback",
    "round-robin",
    "weighted",
    "least-latency",
    "cheapest",
    "balanced",
    "quality-first",
]


@dataclass
class ModelCapabilities:
    streaming: bool | None = None
    tools: bool | None = None
    vision: bool | None = None
    json: bool | None = None
    structuredOutput: bool | None = None
    reasoning: bool | None = None
    audio: bool | None = None
    embeddings: bool | None = None
    multimodal: bool | None = None
    longContext: bool | None = None
    contextWindow: int | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {}
        for k in (
            "streaming",
            "tools",
            "vision",
            "json",
            "structuredOutput",
            "reasoning",
            "audio",
            "embeddings",
            "multimodal",
            "longContext",
            "contextWindow",
        ):
            v = getattr(self, k, None)
            if v is not None:
                res[k] = v
        return res


@dataclass
class LimitRule:
    rpm: int | None = None
    tpm: int | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {}
        if self.rpm is not None:
            res["rpm"] = self.rpm
        if self.tpm is not None:
            res["tpm"] = self.tpm
        return res


RateLimitConfig = LimitRule
LimitConfig = LimitRule


@dataclass
class BudgetRule:
    usd: float
    windowMs: int | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {"usd": self.usd}
        if self.windowMs is not None:
            res["windowMs"] = self.windowMs
        return res


BudgetConfig = BudgetRule


@dataclass
class CircuitBreakerConfig:
    threshold: int | None = None
    cooldownMs: int | None = None
    maxCooldownMs: int | None = None
    cooldown_ms: int | None = None
    max_cooldown_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {}
        if self.threshold is not None:
            res["threshold"] = self.threshold
        cd = self.cooldownMs if self.cooldownMs is not None else self.cooldown_ms
        if cd is not None:
            res["cooldownMs"] = cd
        max_cd = self.maxCooldownMs if self.maxCooldownMs is not None else self.max_cooldown_ms
        if max_cd is not None:
            res["maxCooldownMs"] = max_cd
        return res


@dataclass
class RetryConfig:
    max_retries: int | None = None
    backoff_base_ms: int | None = None
    backoff_cap_ms: int | None = None


@dataclass
class GuardrailConfig:
    blocked_keywords: list[str] | None = None
    max_prompt_tokens: int | None = None
    anonymize_patterns: list[str] | None = None


@dataclass
class ModelRoute:
    id: str
    provider: str
    model: str
    apiKey: str | None = None
    apiKeys: list[str] | None = None
    baseUrl: str | None = None
    apiVersion: str | None = None
    region: str | None = None
    project: str | None = None
    headers: dict[str, str] | None = None
    maxRetries: int | None = None
    timeoutMs: int | None = None
    streamIdleTimeoutMs: int | None = None
    limit: LimitRule | None = None
    budget: BudgetRule | None = None
    weight: float | None = None
    capabilities: ModelCapabilities | None = None

    # Pythonic snake_case parameter support
    api_key: str | None = None
    api_keys: list[str] | None = None
    base_url: str | None = None
    api_version: str | None = None
    max_retries: int | None = None
    timeout_ms: int | None = None
    stream_idle_timeout_ms: int | None = None

    def __post_init__(self) -> None:
        if self.apiKey is None and self.api_key is not None:
            self.apiKey = self.api_key
        if self.apiKeys is None and self.api_keys is not None:
            self.apiKeys = self.api_keys
        if self.baseUrl is None and self.base_url is not None:
            self.baseUrl = self.base_url
        if self.apiVersion is None and self.api_version is not None:
            self.apiVersion = self.api_version
        if self.maxRetries is None and self.max_retries is not None:
            self.maxRetries = self.max_retries
        if self.timeoutMs is None and self.timeout_ms is not None:
            self.timeoutMs = self.timeout_ms
        if self.streamIdleTimeoutMs is None and self.stream_idle_timeout_ms is not None:
            self.streamIdleTimeoutMs = self.stream_idle_timeout_ms

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {
            "id": self.id,
            "provider": self.provider,
            "model": self.model,
        }
        if self.apiKey is not None:
            res["apiKey"] = self.apiKey
        if self.apiKeys is not None:
            res["apiKeys"] = list(self.apiKeys)
        if self.baseUrl is not None:
            res["baseUrl"] = self.baseUrl
        if self.apiVersion is not None:
            res["apiVersion"] = self.apiVersion
        if self.region is not None:
            res["region"] = self.region
        if self.project is not None:
            res["project"] = self.project
        if self.headers is not None:
            res["headers"] = dict(self.headers)
        if self.maxRetries is not None:
            res["maxRetries"] = self.maxRetries
        if self.timeoutMs is not None:
            res["timeoutMs"] = self.timeoutMs
        if self.streamIdleTimeoutMs is not None:
            res["streamIdleTimeoutMs"] = self.streamIdleTimeoutMs
        if self.limit is not None:
            res["limit"] = self.limit.to_dict() if isinstance(self.limit, LimitRule) else self.limit
        if self.budget is not None:
            res["budget"] = self.budget.to_dict() if isinstance(self.budget, BudgetRule) else self.budget
        if self.weight is not None:
            res["weight"] = self.weight
        if self.capabilities is not None:
            res["capabilities"] = (
                self.capabilities.to_dict() if isinstance(self.capabilities, ModelCapabilities) else self.capabilities
            )
        return res


RouteConfig = ModelRoute


@dataclass
class PolicyWeights:
    cost: float | None = None
    speed: float | None = None
    reliability: float | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {}
        if self.cost is not None:
            res["cost"] = self.cost
        if self.speed is not None:
            res["speed"] = self.speed
        if self.reliability is not None:
            res["reliability"] = self.reliability
        return res


@dataclass
class RouterConfig:
    routes: list[ModelRoute]
    strategy: RoutingStrategy | None = None
    weights: PolicyWeights | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {"routes": [r.to_dict() if isinstance(r, ModelRoute) else r for r in self.routes]}
        if self.strategy is not None:
            res["strategy"] = self.strategy
        if self.weights is not None:
            res["weights"] = self.weights.to_dict() if isinstance(self.weights, PolicyWeights) else self.weights
        return res
