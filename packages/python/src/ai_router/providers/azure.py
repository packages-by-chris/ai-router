"""Azure OpenAI provider adapter."""

from __future__ import annotations

import urllib.parse
from collections.abc import Sequence

from .openai import OpenAIAdapter
from .types import NormalizedRoute, RawRequestOptions

AZURE_DEFAULT_API_VERSION = "2024-10-21"
AZURE_OPTION_NAMESPACES = ("openai", "azure")


def _require_azure(route: NormalizedRoute) -> tuple[str, str]:
    if not route.baseUrl:
        raise ValueError(f'route "{route.id}": azure provider requires baseUrl')
    return (
        route.baseUrl.rstrip("/"),
        route.apiVersion or AZURE_DEFAULT_API_VERSION,
    )


def _deployment_url(route: NormalizedRoute, action: str) -> str:
    base, api_version = _require_azure(route)
    return (
        f"{base}/openai/deployments/{urllib.parse.quote(route.model)}/{action}"
        f"?api-version={urllib.parse.quote(api_version)}"
    )


class AzureAdapter(OpenAIAdapter):
    @property
    def id(self) -> str:
        return "azure"

    def label_for(self, route: NormalizedRoute) -> str:
        return "azure"

    def base(self, route: NormalizedRoute) -> str:
        return ""

    def chat_endpoint(self, route: NormalizedRoute) -> str:
        return _deployment_url(route, "chat/completions")

    def embed_endpoint(self, route: NormalizedRoute) -> str:
        return _deployment_url(route, "embeddings")

    def raw_endpoint(self, route: NormalizedRoute, opts: RawRequestOptions) -> str:
        if opts.path is not None:
            base, api_version = _require_azure(route)
            sep = "&" if "?" in opts.path else "?"
            return f"{base}{opts.path}{sep}api-version={urllib.parse.quote(api_version)}"
        return _deployment_url(route, "chat/completions")

    def auth_headers(self, route: NormalizedRoute, key: str) -> dict[str, str]:
        return {"api-key": key}

    def option_namespaces(self) -> Sequence[str]:
        return AZURE_OPTION_NAMESPACES
