"""Router state store interface and task inference."""

from __future__ import annotations

import math
from typing import Any, Protocol, runtime_checkable

DEFAULT_STATE_KEY = "ai-router:state:v1"


@runtime_checkable
class RouterStateStore(Protocol):
    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ttl_ms: int) -> None: ...


def _rough_tokens(req: Any) -> int:
    chars = 0
    messages = getattr(req, "messages", None) if not isinstance(req, dict) else req.get("messages")
    if messages:
        for msg in messages:
            content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
            if isinstance(content, str):
                chars += len(content)
            elif isinstance(content, list):
                chars += sum(len(p.get("text", "") if isinstance(p, dict) else getattr(p, "text", "")) for p in content)
    return math.ceil(chars / 3.5) + 1


def infer_task(req: Any, estimated_input_tokens: int | None = None) -> str:
    """Classifies a request into a workload task bucket."""
    tools = getattr(req, "tools", None) if not isinstance(req, dict) else req.get("tools")
    if tools and len(tools) > 0:
        return "tool-use"

    messages = getattr(req, "messages", None) if not isinstance(req, dict) else req.get("messages")
    if messages:
        for msg in messages:
            content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
            if isinstance(content, list):
                for p in content:
                    p_type = getattr(p, "type", None) if not isinstance(p, dict) else p.get("type")
                    if p_type == "image_url":
                        return "vision"

    rf = getattr(req, "response_format", None) if not isinstance(req, dict) else req.get("response_format")
    if isinstance(rf, dict):
        if rf.get("type") in ("json_schema", "json_object"):
            return "structured"
    elif rf == "json_object":
        return "structured"

    reasoning_effort = (
        getattr(req, "reasoning_effort", None) if not isinstance(req, dict) else req.get("reasoning_effort")
    )
    if reasoning_effort is not None:
        return "reasoning"

    tokens = estimated_input_tokens if estimated_input_tokens is not None else _rough_tokens(req)
    if tokens > 8000:
        return "long-context"

    return "chat"
