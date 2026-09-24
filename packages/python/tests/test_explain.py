"""Unit tests for router.explain() dry-run analysis."""

import pytest

from ai_router import AIRouter, ChatMessage, ChatRequest, parse_config
from ai_router.engine import RoutingEngine


@pytest.fixture
def base_config():
    return parse_config(
        {
            "routes": [
                {
                    "id": "a",
                    "provider": "openai",
                    "model": "gpt-4o",
                    "apiKey": "sk-secret-a",
                    "maxRetries": 0,
                    "capabilities": {"tools": False},
                },
                {
                    "id": "b",
                    "provider": "anthropic",
                    "model": "claude-3-5-sonnet",
                    "apiKey": "sk-secret-b",
                    "maxRetries": 0,
                    "capabilities": {"tools": True},
                },
                {
                    "id": "c",
                    "provider": "gemini",
                    "model": "gemini-2.0-flash",
                    "apiKey": "sk-secret-c",
                    "maxRetries": 0,
                },
            ]
        }
    )


def test_explain_dry_run_no_calls(base_config):
    calls = []

    async def mock_fetch(url, headers, body, timeout_ms=30000):
        calls.append(url)
        raise RuntimeError("should not be called")

    engine = RoutingEngine(base_config, fetch_impl=mock_fetch)
    req = ChatRequest(model="a", messages=[ChatMessage(role="user", content="hello")])

    explanation = engine.explain(req)

    assert explanation.model == "a"
    assert explanation.strategy == "fallback"
    assert len(explanation.candidates) == 3
    assert explanation.selected is not None
    assert explanation.selected.routeId == "a"
    assert [c.status for c in explanation.candidates] == ["selected", "backup", "backup"]
    # Dry run makes 0 network calls
    assert len(calls) == 0


def test_explain_capability_rejection(base_config):
    engine = RoutingEngine(base_config)
    req = ChatRequest(
        model="a",
        messages=[ChatMessage(role="user", content="use tool")],
        tools=[{"type": "function", "function": {"name": "lookup", "parameters": {}}}],  # type: ignore
    )

    explanation = engine.explain(req)

    assert explanation.selected is not None
    assert explanation.selected.routeId == "b"
    assert explanation.candidates[0].routeId == "a"
    assert explanation.candidates[0].status == "rejected"
    assert any("tools" in r for r in explanation.candidates[0].reasons)


@pytest.mark.asyncio
async def test_explain_circuit_breaker():
    config = parse_config(
        {
            "routes": [
                {"id": "r1", "provider": "openai", "model": "gpt-4o", "apiKey": "k1", "maxRetries": 0},
                {"id": "r2", "provider": "openai", "model": "gpt-4o-mini", "apiKey": "k2", "maxRetries": 0},
            ]
        }
    )

    async def mock_fetch(url, headers, body, timeout_ms=30000):
        from ai_router.http.request import HttpResponse

        auth = headers.get("authorization", "")
        if "k1" in auth:
            return HttpResponse(status=500, headers={}, body=b'{"error": "server error"}')
        return HttpResponse(
            status=200,
            headers={"content-type": "application/json"},
            body=b'{"id":"1","choices":[{"message":{"role":"assistant","content":"ok"}}]}',
        )

    engine = RoutingEngine(config, fetch_impl=mock_fetch, circuit_breaker={"threshold": 1, "cooldownMs": 60000})

    req = ChatRequest(model="r1", messages=[ChatMessage(role="user", content="hi")])
    await engine.complete(req)

    explanation = engine.explain(req)
    assert explanation.candidates[0].routeId == "r1"
    assert explanation.candidates[0].status == "rejected"
    assert any("circuit breaker open" in r for r in explanation.candidates[0].reasons)
    assert explanation.selected is not None
    assert explanation.selected.routeId == "r2"


def test_router_sync_explain(base_config):
    router = AIRouter(base_config)
    explanation = router.explain_sync({"model": "a", "messages": [{"role": "user", "content": "hi"}]})
    assert explanation.model == "a"
    assert explanation.selected is not None
    assert explanation.selected.routeId == "a"
