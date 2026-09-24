"""Tests for model capabilities and requirement inference."""

from ai_router import (
    ChatMessage,
    ChatRequest,
    ModelCapabilities,
    Tool,
    capability_rejection,
    inferred_requirements,
)


def test_inferred_requirements() -> None:
    req = ChatRequest(
        model="fast",
        messages=[ChatMessage(role="user", content="hello")],
        tools=[Tool(function={"name": "test", "parameters": {}})],
        reasoning_effort="high",
    )
    inferred = inferred_requirements(req, "complete")
    assert inferred.get("tools") is True
    assert inferred.get("reasoning") is True
    assert inferred.get("vision") is None


def test_capability_rejection_explicit_require() -> None:
    caps = ModelCapabilities(tools=False, vision=True)
    req = ChatRequest(model="fast", messages=[ChatMessage(role="user", content="hi")])
    rej = capability_rejection(caps, req, "complete", require={"tools": True})
    assert rej == "requires tools but route does not declare it"


def test_capability_rejection_inferred() -> None:
    caps = ModelCapabilities(tools=False, vision=True)
    req = ChatRequest(
        model="fast",
        messages=[ChatMessage(role="user", content="hi")],
        tools=[Tool(function={"name": "f", "parameters": {}})],
    )
    rej = capability_rejection(caps, req, "complete", require=None)
    assert rej == "request needs tools but route does not declare it"


def test_undeclared_profile_passes_inferred() -> None:
    req = ChatRequest(
        model="fast",
        messages=[ChatMessage(role="user", content="hi")],
        tools=[Tool(function={"name": "f", "parameters": {}})],
    )
    rej = capability_rejection(None, req, "complete", require=None)
    assert rej is None
