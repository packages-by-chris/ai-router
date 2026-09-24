import json

import pytest

from ai_router.config.schema import CircuitBreakerConfig, RouteConfig, RouterConfig
from ai_router.engine import RoutingEngine
from ai_router.errors import AllRoutesFailedError
from ai_router.http.request import HttpResponse
from ai_router.types import ChatMessage, ChatRequest


def make_mock_fetch(responses: list[HttpResponse | Exception]):
    call_count = 0

    async def mock_fetch(url: str, headers: dict[str, str], body: bytes | None, timeout_ms: int) -> HttpResponse:
        nonlocal call_count
        if call_count >= len(responses):
            raise RuntimeError(f"Unexpected fetch call {call_count}")
        res = responses[call_count]
        call_count += 1
        if isinstance(res, Exception):
            raise res
        return res

    return mock_fetch


@pytest.mark.asyncio
async def test_engine_single_successful_request():
    mock_resp = HttpResponse(
        status=200,
        headers={"content-type": "application/json"},
        body=json.dumps(
            {
                "id": "chatcmpl-123",
                "model": "gpt-4o",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "Hello!"}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }
        ).encode(),
    )

    engine = RoutingEngine(
        config=RouterConfig(
            routes=[
                RouteConfig(id="primary", provider="openai", model="gpt-4o", api_key="sk-test"),
            ]
        ),
        fetch_impl=make_mock_fetch([mock_resp]),
    )

    req = ChatRequest(model="primary", messages=[ChatMessage(role="user", content="Hi")])
    res = await engine.complete(req)

    assert res.id == "chatcmpl-123"
    assert res.choices[0].message.content == "Hello!"


@pytest.mark.asyncio
async def test_engine_fallback_on_failure():
    resp_500 = HttpResponse(
        status=500,
        headers={"content-type": "application/json"},
        body=json.dumps({"error": {"message": "Internal server error"}}).encode(),
    )
    resp_200 = HttpResponse(
        status=200,
        headers={"content-type": "application/json"},
        body=json.dumps(
            {
                "id": "chatcmpl-fallback",
                "model": "claude-3-5-sonnet",
                "content": [{"type": "text", "text": "Fallback success!"}],
                "role": "assistant",
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 8, "output_tokens": 4},
            }
        ).encode(),
    )

    engine = RoutingEngine(
        config=RouterConfig(
            routes=[
                RouteConfig(id="primary", provider="openai", model="gpt-4o", api_key="sk-test", max_retries=0),
                RouteConfig(
                    id="secondary", provider="anthropic", model="claude-3-5-sonnet", api_key="sk-ant", max_retries=0
                ),
            ]
        ),
        fetch_impl=make_mock_fetch([resp_500, resp_200]),
        sleep=lambda ms: None,
    )

    req = ChatRequest(model="primary", messages=[ChatMessage(role="user", content="Hi")])
    attempts = []
    res = await engine.complete(req, on_attempt=lambda att: attempts.append(att))

    assert res.choices[0].message.content == "Fallback success!"
    assert len(attempts) == 2
    assert attempts[0].status == 500
    assert attempts[1].status == 200


@pytest.mark.asyncio
async def test_engine_key_rotation_on_429():
    resp_429 = HttpResponse(
        status=429,
        headers={"content-type": "application/json", "retry-after": "5"},
        body=json.dumps({"error": {"message": "Rate limited"}}).encode(),
    )
    resp_200 = HttpResponse(
        status=200,
        headers={"content-type": "application/json"},
        body=json.dumps(
            {
                "id": "chatcmpl-rot",
                "model": "gpt-4o",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "Key 2 success"}, "finish_reason": "stop"}
                ],
            }
        ).encode(),
    )

    engine = RoutingEngine(
        config=RouterConfig(
            routes=[
                RouteConfig(
                    id="primary", provider="openai", model="gpt-4o", api_keys=["key-1", "key-2"], max_retries=0
                ),
            ]
        ),
        fetch_impl=make_mock_fetch([resp_429, resp_200]),
        sleep=lambda ms: None,
    )

    req = ChatRequest(model="primary", messages=[ChatMessage(role="user", content="Hi")])
    res = await engine.complete(req)
    assert res.choices[0].message.content == "Key 2 success"


@pytest.mark.asyncio
async def test_engine_circuit_breaker():
    resp_500 = HttpResponse(
        status=500,
        headers={"content-type": "application/json"},
        body=json.dumps({"error": {"message": "Server down"}}).encode(),
    )

    engine = RoutingEngine(
        config=RouterConfig(
            routes=[
                RouteConfig(id="r1", provider="openai", model="gpt-4o", api_key="sk-1", max_retries=0),
            ]
        ),
        circuit_breaker=CircuitBreakerConfig(threshold=1, cooldown_ms=60000),
        fetch_impl=make_mock_fetch([resp_500]),
        sleep=lambda ms: None,
    )

    req = ChatRequest(model="r1", messages=[ChatMessage(role="user", content="Hi")])
    with pytest.raises(AllRoutesFailedError):
        await engine.complete(req)

    # Circuit breaker should now be open
    cb = engine._cb_state.get("r1")
    assert cb is not None
    assert cb["opens"] >= 1
