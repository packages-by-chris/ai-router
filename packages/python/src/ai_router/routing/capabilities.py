"""Capability-aware routing metadata.

Routes may declare what their model supports (`capabilities` in config).
Requirements reach the router two ways, with different failure semantics:

  1. Explicit requirements (`routing.require`) are HARD constraints: a
     candidate must declare the capability true, otherwise it is
     eliminated — including candidates with NO declared profile.
  2. Request-inferred requirements (request carries tools -> needs tools,
     image parts -> vision, json_schema -> structuredOutput,
     reasoning_effort -> reasoning, stream()/embed() -> their flags) are
     METADATA-DRIVEN: only candidates that DECLARE a conflicting profile
     are eliminated. Undeclared routes stay eligible so existing configs
     never change behavior.
"""

from __future__ import annotations

from typing import Any, Literal

from ..config.schema import ModelCapabilities

Role = Literal["system", "user", "assistant", "tool"]
RouteOp = Literal["complete", "stream", "embed"]


CapabilityRequirement = dict[str, bool]

BOOLEAN_CAPS = (
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
)


def inferred_requirements(req: Any, op: RouteOp) -> CapabilityRequirement:
    """Requirements implied by the logical request itself."""
    need: CapabilityRequirement = {}
    if op == "stream":
        need["streaming"] = True
    if op == "embed":
        need["embeddings"] = True

    tools = getattr(req, "tools", None) if not isinstance(req, dict) else req.get("tools")
    if tools and len(tools) > 0:
        need["tools"] = True

    messages = getattr(req, "messages", None) if not isinstance(req, dict) else req.get("messages")
    if messages:
        for msg in messages:
            content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
            if isinstance(content, list):
                for p in content:
                    p_type = getattr(p, "type", None) if not isinstance(p, dict) else p.get("type")
                    if p_type == "image_url":
                        need["vision"] = True
                        break
            if need.get("vision"):
                break

    resp_fmt = getattr(req, "response_format", None) if not isinstance(req, dict) else req.get("response_format")
    if isinstance(resp_fmt, dict):
        if resp_fmt.get("type") == "json_object":
            need["json"] = True
        elif resp_fmt.get("type") == "json_schema":
            need["structuredOutput"] = True
    elif resp_fmt == "json_object":
        need["json"] = True

    reasoning_effort = (
        getattr(req, "reasoning_effort", None) if not isinstance(req, dict) else req.get("reasoning_effort")
    )
    if reasoning_effort is not None:
        need["reasoning"] = True

    return need


def capability_rejection(
    caps: ModelCapabilities | dict[str, Any] | None,
    req: Any,
    op: RouteOp,
    require: CapabilityRequirement | None,
    estimated_input_tokens: int | None = None,
) -> str | None:
    """Rejection reason when a candidate cannot serve this request, or None when eligible."""
    inferred = inferred_requirements(req, op)

    # Convert caps to dict for uniform access
    caps_dict: dict[str, Any] | None = None
    if caps is not None:
        if isinstance(caps, ModelCapabilities):
            caps_dict = caps.to_dict()
        elif isinstance(caps, dict):
            caps_dict = caps

    # Hard constraints first: explicit demands beat declarations' absence
    if require:
        for key in BOOLEAN_CAPS:
            if require.get(key) is True and (not caps_dict or caps_dict.get(key) is not True):
                return f"requires {key} but route does not declare it"

    # Metadata-driven inference: only declared profiles can conflict
    if caps_dict is not None:
        for key in BOOLEAN_CAPS:
            if inferred.get(key) is True and caps_dict.get(key) is not True:
                return f"request needs {key} but route does not declare it"

        cw = caps_dict.get("contextWindow")
        if isinstance(cw, (int, float)) and estimated_input_tokens is not None and estimated_input_tokens > cw:
            return f"estimated {estimated_input_tokens} input tokens exceeds contextWindow {cw}"

    return None
