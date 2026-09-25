"""Hand-rolled configuration validation and interpolation (zero runtime dependencies).

Collects ALL violations and reports them with JSON-path style locations so both
the TypeScript and Python SDKs emit identical error messages.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any

from ..errors import ConfigError
from ..providers.presets import get_preset
from ..providers.registry import known_provider_ids
from ..routing.capabilities import ModelCapabilities
from .schema import (
    BudgetRule,
    LimitRule,
    ModelRoute,
    PolicyWeights,
    RouterConfig,
    RoutingStrategy,
)

ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

TOP_LEVEL_FIELDS = frozenset(["routes", "strategy", "weights"])
WEIGHT_FIELDS = frozenset(["cost", "speed", "reliability"])
ROUTE_FIELDS = frozenset(
    [
        "id",
        "provider",
        "model",
        "apiKey",
        "apiKeys",
        "baseUrl",
        "apiVersion",
        "region",
        "project",
        "headers",
        "maxRetries",
        "timeoutMs",
        "streamIdleTimeoutMs",
        "limit",
        "budget",
        "weight",
        "capabilities",
    ]
)
LIMIT_FIELDS = frozenset(["rpm", "tpm"])
BUDGET_FIELDS = frozenset(["usd", "windowMs"])
CAPABILITY_FIELDS = frozenset(
    [
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
    ]
)
STRATEGIES = frozenset(
    [
        "fallback",
        "round-robin",
        "weighted",
        "least-latency",
        "cheapest",
        "balanced",
        "quality-first",
    ]
)


def _interpolate_env(value: str, env: Mapping[str, str], path: str) -> str:
    if "${" not in value:
        return value

    def replace_var(match: re.Match[str]) -> str:
        var_name = match.group(1)
        if var_name not in env:
            raise ConfigError(f'{path}: environment variable "{var_name}" is not set')
        return env[var_name]

    return ENV_PATTERN.sub(replace_var, value)


def _interpolate_deep(obj: Any, env: Mapping[str, str], path: str) -> Any:
    if isinstance(obj, str):
        return _interpolate_env(obj, env, path)
    if isinstance(obj, list):
        return [_interpolate_deep(item, env, f"{path}[{i}]") for i, item in enumerate(obj)]
    if isinstance(obj, dict):
        return {k: _interpolate_deep(v, env, f"{path}.{k}") for k, v in obj.items()}
    return obj


def _is_dict(v: Any) -> bool:
    return isinstance(v, dict)


def _positive_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def _positive_number(v: Any) -> bool:
    return (isinstance(v, (int, float)) and not isinstance(v, bool)) and v > 0


def parse_config(
    input_config: Any,
    env: Mapping[str, str] | None = None,
) -> RouterConfig:
    """Validates and parses a router config dictionary or JSON object with ${ENV_VAR} interpolation."""
    resolved_env = env if env is not None else os.environ
    interpolated = _interpolate_deep(input_config, resolved_env, "config")

    errors: list[str] = []

    if not _is_dict(interpolated):
        raise ConfigError("config: expected an object")

    routes_raw = interpolated.get("routes")
    if not isinstance(routes_raw, list):
        raise ConfigError("config.routes: expected an array")
    if len(routes_raw) == 0:
        raise ConfigError("config.routes: must not be empty")

    for key in interpolated.keys():
        if key not in TOP_LEVEL_FIELDS:
            errors.append(f"config.{key}: unknown field (known: routes, strategy, weights)")

    strategy_raw = interpolated.get("strategy")
    if strategy_raw is not None and (not isinstance(strategy_raw, str) or strategy_raw not in STRATEGIES):
        errors.append(
            'config.strategy: must be "fallback", "round-robin", "weighted", "least-latency", "cheapest", "balanced", or "quality-first"'
        )

    weights: PolicyWeights | None = None
    weights_raw = interpolated.get("weights")
    if weights_raw is not None:
        if not _is_dict(weights_raw):
            errors.append("config.weights: expected an object")
        else:
            for key in weights_raw.keys():
                if key not in WEIGHT_FIELDS:
                    errors.append(f"config.weights.{key}: unknown field (known: cost, speed, reliability)")

            w_dict: dict[str, float] = {}
            for key in WEIGHT_FIELDS:
                val = weights_raw.get(key)
                if val is None:
                    continue
                if not _positive_number(val):
                    errors.append(f"config.weights.{key}: must be a positive number")
                    continue
                w_dict[key] = float(val)

            if len(w_dict) == 0:
                errors.append("config.weights: expected at least one of cost, speed, reliability")
            elif len(errors) == 0:
                weights = PolicyWeights(
                    cost=w_dict.get("cost"),
                    speed=w_dict.get("speed"),
                    reliability=w_dict.get("reliability"),
                )

    seen_ids: set[str] = set()
    routes: list[ModelRoute] = []

    for i, raw in enumerate(routes_raw):
        at = f"config.routes[{i}]"
        if not _is_dict(raw):
            errors.append(f"{at}: expected an object")
            continue

        for key in raw.keys():
            if key not in ROUTE_FIELDS:
                errors.append(f"{at}.{key}: unknown field")

        route_id = raw.get("id")
        if not isinstance(route_id, str) or len(route_id) == 0:
            errors.append(f"{at}.id: must be a non-empty string")
            continue
        if route_id in seen_ids:
            errors.append(f'{at}.id: duplicate route id "{route_id}"')
            continue
        seen_ids.add(route_id)

        provider = raw.get("provider")
        known = known_provider_ids()
        if not isinstance(provider, str) or provider not in known:
            errors.append(f'{at}.provider: unknown provider "{provider}" (known: {", ".join(known)})')
            continue

        model = raw.get("model")
        if not isinstance(model, str) or len(model) == 0:
            errors.append(f"{at}.model: must be a non-empty string")
            continue

        key_pool: list[str] = []
        api_key = raw.get("apiKey")
        if api_key is not None:
            if not isinstance(api_key, str) or len(api_key) == 0:
                errors.append(f"{at}.apiKey: must be a non-empty string")
                continue
            key_pool.append(api_key)

        api_keys = raw.get("apiKeys")
        if api_keys is not None:
            if (
                not isinstance(api_keys, list)
                or len(api_keys) == 0
                or not all(isinstance(k, str) and len(k) > 0 for k in api_keys)
            ):
                errors.append(f"{at}.apiKeys: must be a non-empty array of non-empty strings")
                continue
            key_pool.extend(api_keys)

        if len(key_pool) == 0:
            preset = get_preset(provider)
            if not preset or preset.auth != "none":
                errors.append(f'{at}: needs "apiKey" or "apiKeys"')
                continue

        base_url = raw.get("baseUrl")
        if provider == "openai-compatible" and (not isinstance(base_url, str) or len(base_url) == 0):
            errors.append(f'{at}.baseUrl: required when provider is "openai-compatible"')
            continue
        if provider == "azure" and (not isinstance(base_url, str) or len(base_url) == 0):
            errors.append(
                f'{at}.baseUrl: required when provider is "azure" (resource root, e.g. https://my-res.openai.azure.com)'
            )

        api_version = raw.get("apiVersion")
        if provider == "azure":
            if not isinstance(api_version, str) or len(api_version) == 0:
                errors.append(f'{at}.apiVersion: required when provider is "azure" (e.g. "2024-10-21")')
        elif api_version is not None:
            errors.append(f'{at}.apiVersion: only valid when provider is "azure"')

        region = raw.get("region")
        if provider in ("bedrock", "vertex"):
            if not isinstance(region, str) or len(region) == 0:
                hint = 'e.g. "us-east-1"'
                errors.append(f'{at}.region: required when provider is "{provider}" ({hint})')
                continue
        elif region is not None:
            errors.append(f'{at}.region: only valid when provider is "bedrock" or "vertex"')
            continue

        project = raw.get("project")
        if provider == "vertex":
            if not isinstance(project, str) or len(project) == 0:
                errors.append(f'{at}.project: required when provider is "vertex" (GCP project id)')
                continue
        elif project is not None:
            errors.append(f'{at}.project: only valid when provider is "vertex"')
            continue

        if base_url is not None and (not isinstance(base_url, str) or len(base_url) == 0):
            errors.append(f"{at}.baseUrl: must be a non-empty string")
            continue

        weight = raw.get("weight")
        if weight is not None and not _positive_number(weight):
            errors.append(f"{at}.weight: must be a positive number")
            continue

        headers = raw.get("headers")
        if headers is not None:
            if not _is_dict(headers) or not all(isinstance(v, str) for v in headers.values()):
                errors.append(f"{at}.headers: must be an object of string -> string")
                continue

        max_retries = raw.get("maxRetries")
        if max_retries is not None and not (_positive_int(max_retries) or max_retries == 0):
            errors.append(f"{at}.maxRetries: must be a positive integer")
            continue

        timeout_ms = raw.get("timeoutMs")
        if timeout_ms is not None and not _positive_int(timeout_ms):
            errors.append(f"{at}.timeoutMs: must be a positive integer")
            continue

        stream_idle_timeout_ms = raw.get("streamIdleTimeoutMs")
        if stream_idle_timeout_ms is not None and not _positive_int(stream_idle_timeout_ms):
            errors.append(f"{at}.streamIdleTimeoutMs: must be a positive integer")
            continue

        limit: LimitRule | None = None
        limit_raw = raw.get("limit")
        if limit_raw is not None:
            if not _is_dict(limit_raw):
                errors.append(f"{at}.limit: expected an object")
                continue
            for k in limit_raw.keys():
                if k not in LIMIT_FIELDS:
                    errors.append(f"{at}.limit.{k}: unknown field (known: rpm, tpm)")
            rpm_val = limit_raw.get("rpm")
            if rpm_val is not None and not _positive_int(rpm_val):
                errors.append(f"{at}.limit.rpm: must be a positive integer")
                continue
            tpm_val = limit_raw.get("tpm")
            if tpm_val is not None and not _positive_int(tpm_val):
                errors.append(f"{at}.limit.tpm: must be a positive integer")
                continue
            limit = LimitRule(rpm=rpm_val, tpm=tpm_val)

        budget: BudgetRule | None = None
        budget_raw = raw.get("budget")
        if budget_raw is not None:
            if not _is_dict(budget_raw):
                errors.append(f"{at}.budget: expected an object")
                continue
            for k in budget_raw.keys():
                if k not in BUDGET_FIELDS:
                    errors.append(f"{at}.budget.{k}: unknown field (known: usd, windowMs)")
            usd_val = budget_raw.get("usd")
            if usd_val is None or not _positive_number(usd_val):
                errors.append(f"{at}.budget.usd: must be a positive number")
                continue
            win_ms = budget_raw.get("windowMs")
            if win_ms is not None and not _positive_int(win_ms):
                errors.append(f"{at}.budget.windowMs: must be a positive integer")
                continue
            budget = BudgetRule(usd=float(usd_val), windowMs=win_ms)

        capabilities: ModelCapabilities | None = None
        caps_raw = raw.get("capabilities")
        if caps_raw is not None:
            if not _is_dict(caps_raw):
                errors.append(f"{at}.capabilities: expected an object")
                continue
            for k in caps_raw.keys():
                if k not in CAPABILITY_FIELDS:
                    errors.append(
                        f"{at}.capabilities.{k}: unknown field (known: {', '.join(sorted(CAPABILITY_FIELDS))})"
                    )
            caps_dict: dict[str, Any] = {}
            for k in CAPABILITY_FIELDS:
                val = caps_raw.get(k)
                if val is None:
                    continue
                if k == "contextWindow":
                    if not _positive_int(val):
                        errors.append(f"{at}.capabilities.contextWindow: must be a positive integer")
                        break
                    caps_dict[k] = val
                else:
                    if not isinstance(val, bool):
                        errors.append(f"{at}.capabilities.{k}: must be a boolean")
                        break
                    caps_dict[k] = val
            capabilities = ModelCapabilities(**caps_dict)

        routes.append(
            ModelRoute(
                id=route_id,
                provider=provider,
                model=model,
                apiKey=api_key,
                apiKeys=list(api_keys) if api_keys is not None else None,
                baseUrl=base_url,
                apiVersion=api_version,
                region=region,
                project=project,
                headers=dict(headers) if headers is not None else None,
                maxRetries=max_retries,
                timeoutMs=timeout_ms,
                streamIdleTimeoutMs=stream_idle_timeout_ms,
                limit=limit,
                budget=budget,
                weight=float(weight) if weight is not None else None,
                capabilities=capabilities,
            )
        )

    if len(errors) > 0:
        raise ConfigError("\n".join(errors))

    from typing import cast

    return RouterConfig(
        routes=routes,
        strategy=cast(RoutingStrategy, strategy_raw) if isinstance(strategy_raw, str) else None,
        weights=weights,
    )
