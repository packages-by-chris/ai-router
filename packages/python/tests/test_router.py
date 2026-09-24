import json

import pytest

from ai_router.http.request import HttpResponse
from ai_router.router import AIRouter
from ai_router.types import ChatMessage, ChatRequest


def make_mock_fetch(response: HttpResponse):
    async def mock_fetch(url: str, headers: dict[str, str], body: bytes | None, timeout_ms: int) -> HttpResponse:
        return response

    return mock_fetch


@pytest.mark.asyncio
async def test_ai_router_async_complete():
    mock_resp = HttpResponse(
        status=200,
        headers={"content-type": "application/json"},
        body=json.dumps(
            {
                "id": "chatcmpl-facade",
                "model": "gpt-4o",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "Async Hello!"}, "finish_reason": "stop"}
                ],
            }
        ).encode(),
    )

    router = AIRouter(
        config={"routes": [{"id": "gpt-4o-route", "provider": "openai", "model": "gpt-4o", "apiKey": "sk-test"}]},
        fetch_impl=make_mock_fetch(mock_resp),
    )

    resp = await router.complete(
        ChatRequest(model="gpt-4o-route", messages=[ChatMessage(role="user", content="Hello")])
    )
    assert resp.choices[0].message.content == "Async Hello!"


def test_ai_router_sync_complete():
    mock_resp = HttpResponse(
        status=200,
        headers={"content-type": "application/json"},
        body=json.dumps(
            {
                "id": "chatcmpl-facade-sync",
                "model": "gpt-4o",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "Sync Hello!"}, "finish_reason": "stop"}
                ],
            }
        ).encode(),
    )

    router = AIRouter(
        config={"routes": [{"id": "gpt-4o-route", "provider": "openai", "model": "gpt-4o", "apiKey": "sk-test"}]},
        fetch_impl=make_mock_fetch(mock_resp),
    )

    resp = router.complete_sync(ChatRequest(model="gpt-4o-route", messages=[ChatMessage(role="user", content="Hello")]))
    assert resp.choices[0].message.content == "Sync Hello!"


def test_ai_router_explain():
    router = AIRouter(
        config={
            "routes": [
                {"id": "route-a", "provider": "openai", "model": "gpt-4o", "apiKey": "sk-1"},
                {"id": "route-b", "provider": "anthropic", "model": "claude-3-5-sonnet", "apiKey": "sk-2"},
            ]
        }
    )

    explanation = router.explain_sync(
        ChatRequest(model="route-a", messages=[ChatMessage(role="user", content="Hello")])
    )
    assert explanation.target_id == "route-a"
    assert len(explanation.candidates) == 2
    assert explanation.strategy == "fallback"
