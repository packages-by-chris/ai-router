"""Multi-tier failure simulation tests: retry -> key rotation -> route fallback -> circuit breaker."""

import pytest

from ai_router import AIRouter, AllRoutesFailedError, ChatMessage, ChatRequest, parse_config
from ai_router.http.request import HttpResponse


@pytest.mark.asyncio
async def test_key_rotation_then_fallback_route():
    attempts_seen = []

    async def mock_fetch(url, headers, body, timeout_ms=30000):
        auth = headers.get("authorization", "")
        attempts_seen.append(auth)
        if "key-1" in auth:
            # 429 on first key
            return HttpResponse(status=429, headers={"retry-after": "5"}, body=b'{"error": "rate limited"}')
        if "key-2" in auth:
            # 500 on second key
            return HttpResponse(status=500, headers={}, body=b'{"error": "internal error"}')
        if "key-backup" in auth:
            # Success on backup route
            return HttpResponse(
                status=200,
                headers={"content-type": "application/json"},
                body=b'{"id":"chatcmpl-1","choices":[{"message":{"role":"assistant","content":"Success"}}]}',
            )
        return HttpResponse(status=400, headers={}, body=b'{"error":"bad request"}')

    config = parse_config(
        {
            "routes": [
                {
                    "id": "primary",
                    "provider": "openai",
                    "model": "gpt-4o",
                    "apiKeys": ["key-1", "key-2"],
                    "maxRetries": 0,
                },
                {
                    "id": "secondary",
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "apiKey": "key-backup",
                    "maxRetries": 0,
                },
            ]
        }
    )

    router = AIRouter(config, fetch_impl=mock_fetch)
    req = ChatRequest(model="primary", messages=[ChatMessage(role="user", content="hello")])

    res = await router.complete(req)

    assert res.choices[0].message.content == "Success"
    assert len(attempts_seen) == 3
    assert "Bearer key-1" in attempts_seen[0]
    assert "Bearer key-2" in attempts_seen[1]
    assert "Bearer key-backup" in attempts_seen[2]


@pytest.mark.asyncio
async def test_all_routes_fail_accumulates_attempt_records():
    async def always_failing_fetch(url, headers, body, timeout_ms=30000):
        return HttpResponse(status=503, headers={}, body=b'{"error": "service unavailable"}')

    config = parse_config(
        {
            "routes": [
                {"id": "r1", "provider": "openai", "model": "m1", "apiKey": "k1", "maxRetries": 0},
                {"id": "r2", "provider": "openai", "model": "m2", "apiKey": "k2", "maxRetries": 0},
            ]
        }
    )

    router = AIRouter(config, fetch_impl=always_failing_fetch)
    req = ChatRequest(model="r1", messages=[ChatMessage(role="user", content="hello")])

    with pytest.raises(AllRoutesFailedError) as exc_info:
        await router.complete(req)

    err = exc_info.value
    assert len(err.attempts) == 2
    assert err.attempts[0].route_id == "r1"
    assert err.attempts[1].route_id == "r2"
    assert "all routes failed (2 attempted)" in str(err)


@pytest.mark.asyncio
async def test_single_key_429_retries_with_backoff():
    attempts_seen = []
    slept = []

    async def mock_fetch(url, headers, body, timeout_ms=30000):
        attempts_seen.append(headers.get("authorization", ""))
        if len(attempts_seen) == 1:
            return HttpResponse(status=429, headers={"retry-after": "1"}, body=b'{"error": "rate limited"}')
        return HttpResponse(
            status=200,
            headers={"content-type": "application/json"},
            body=b'{"id":"chatcmpl-1","choices":[{"message":{"role":"assistant","content":"Recovered"}}]}',
        )

    config = parse_config(
        {
            "routes": [
                {
                    "id": "primary",
                    "provider": "openai",
                    "model": "gpt-4o",
                    "apiKey": "single-key",
                    "maxRetries": 2,
                }
            ]
        }
    )

    async def mock_sleep(ms):
        slept.append(ms)

    router = AIRouter(config, fetch_impl=mock_fetch, sleep=mock_sleep)
    req = ChatRequest(model="primary", messages=[ChatMessage(role="user", content="hello")])

    res = await router.complete(req)
    assert res.choices[0].message.content == "Recovered"
    assert len(attempts_seen) == 2
    assert len(slept) == 1
    assert slept[0] >= 1000  # at least 1s from Retry-After


@pytest.mark.asyncio
async def test_circuit_breaker_half_open_canary():
    attempts_seen = []
    calls = 0

    async def mock_fetch(url, headers, body, timeout_ms=30000):
        nonlocal calls
        calls += 1
        model = "model-a" if "key-a" in headers.get("authorization", "") else "model-b"
        attempts_seen.append(model)
        if calls == 1:
            return HttpResponse(status=500, headers={}, body=b'{"error": "server error"}')
        return HttpResponse(
            status=200,
            headers={"content-type": "application/json"},
            body=f'{{"id":"chatcmpl-1","model":"{model}","choices":[{{"message":{{"role":"assistant","content":"ok"}}}}]}}'.encode(),
        )

    config = parse_config(
        {
            "routes": [
                {"id": "a", "provider": "openai", "model": "model-a", "apiKey": "key-a", "maxRetries": 0},
                {"id": "b", "provider": "openai", "model": "model-b", "apiKey": "key-b", "maxRetries": 0},
            ]
        }
    )

    router = AIRouter(config, fetch_impl=mock_fetch, circuitBreaker={"threshold": 1, "cooldownMs": 100})
    req = ChatRequest(model="a", messages=[ChatMessage(role="user", content="hi")])

    # Call 1: route a fails -> route b serves -> breaker for a opens
    res1 = await router.complete(req)
    assert res1.model == "model-b"

    # Advance clock past cooldown: route a becomes half-open
    router.engine._cb_state["a"]["openUntil"] = 0.001

    # Call 2: canary probe on route a succeeds -> breaker closes
    res2 = await router.complete(req)
    assert res2.model == "model-a"

