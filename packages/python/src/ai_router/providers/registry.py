"""Adapter registry for built-in and third-party provider adapters."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from ..errors import UnsupportedProviderError
from .presets import PROVIDER_PRESETS

BUILTIN_PROVIDER_IDS: list[str] = [
    "openai",
    "azure",
    "anthropic",
    "gemini",
    "bedrock",
    "vertex",
]

_builtin_adapters: dict[str, Any] = {}
_custom_adapters: dict[str, Any] = {}


def register_builtin_adapter(id: str, adapter: Any) -> None:
    _builtin_adapters[id] = adapter


def register_adapter(id: str, create: Callable[[], Any]) -> None:
    """Register a third-party adapter under a provider id."""
    if id in BUILTIN_PROVIDER_IDS or id == "openai-compatible":
        raise ValueError(f'register_adapter: "{id}" collides with a built-in provider')
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9_-]*$", id):
        raise ValueError(f'register_adapter: "{id}" must match [a-zA-Z][a-zA-Z0-9_-]*')
    _custom_adapters[id] = create()


def known_provider_ids() -> list[str]:
    """Every provider id valid in route configs: built-ins + preset ids + registered custom ids."""
    res: list[str] = list(BUILTIN_PROVIDER_IDS)
    res.append("openai-compatible")
    res.extend(list(PROVIDER_PRESETS.keys()))
    res.extend(list(_custom_adapters.keys()))
    return res


def get_adapter(provider_id: str) -> Any:
    # Ensure built-ins are loaded
    if not _builtin_adapters:
        from .anthropic import AnthropicAdapter
        from .azure import AzureAdapter
        from .bedrock import BedrockAdapter
        from .gemini import GeminiAdapter
        from .openai import OpenAIAdapter
        from .vertex import VertexAdapter

        _builtin_adapters["openai"] = OpenAIAdapter()
        _builtin_adapters["azure"] = AzureAdapter()
        _builtin_adapters["anthropic"] = AnthropicAdapter()
        _builtin_adapters["gemini"] = GeminiAdapter()
        _builtin_adapters["bedrock"] = BedrockAdapter()
        _builtin_adapters["vertex"] = VertexAdapter()

    lookup_id = "openai" if provider_id == "openai-compatible" else provider_id
    if lookup_id in _builtin_adapters:
        return _builtin_adapters[lookup_id]
    if provider_id in _custom_adapters:
        return _custom_adapters[provider_id]
    raise UnsupportedProviderError(
        f'provider "{provider_id}" is not implemented'
        + ("" if provider_id in PROVIDER_PRESETS else f" (known: {', '.join(known_provider_ids())})")
    )


def is_supported(provider_id: str) -> bool:
    lookup_id = "openai" if provider_id == "openai-compatible" else provider_id
    return lookup_id in BUILTIN_PROVIDER_IDS or provider_id in PROVIDER_PRESETS or provider_id in _custom_adapters
