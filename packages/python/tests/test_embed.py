"""Unit tests for embedding requests across providers."""

import json

import pytest

from ai_router import AIRouter, EmbeddingRequest, ProviderError, parse_config


@pytest.mark.asyncio
async def test_embed_openai_success():
    config = parse_config(
        {"routes": [{"id": "emb", "provider": "openai", "model": "text-embedding-3-small", "apiKey": "sk-test"}]}
    )

    async def mock_fetch(url, headers, body, timeout_ms=30000):
        from ai_router.http.request import HttpResponse

        req_json = json.loads(body.decode()) if body else {}
        assert req_json["model"] == "text-embedding-3-small"
        assert req_json["input"] == ["hello world"]

        return HttpResponse(
            status=200,
            headers={"content-type": "application/json"},
            body=json.dumps(
                {
                    "object": "list",
                    "data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2, 0.3]}],
                    "model": "text-embedding-3-small",
                    "usage": {"prompt_tokens": 2, "total_tokens": 2},
                }
            ).encode(),
        )

    router = AIRouter(config, fetch_impl=mock_fetch)
    res = await router.embed(EmbeddingRequest(model="emb", input=["hello world"]))

    assert res.object == "list"
    assert res.model == "text-embedding-3-small"
    assert len(res.data) == 1
    assert res.data[0].embedding == [0.1, 0.2, 0.3]
    assert res.usage is not None
    assert res.usage.total_tokens == 2


@pytest.mark.asyncio
async def test_embed_anthropic_unsupported():
    config = parse_config(
        {"routes": [{"id": "emb", "provider": "anthropic", "model": "claude-3-5-sonnet", "apiKey": "sk-ant"}]}
    )
    router = AIRouter(config)

    with pytest.raises(ProviderError) as exc_info:
        await router.embed(EmbeddingRequest(model="emb", input="test"))

    assert exc_info.value.kind == "invalid_request"
    assert "embeddings not supported" in str(exc_info.value)


@pytest.mark.asyncio
async def test_embed_bedrock_unsupported():
    config = parse_config(
        {
            "routes": [
                {
                    "id": "emb",
                    "provider": "bedrock",
                    "model": "anthropic.claude-3",
                    "apiKey": "k",
                    "region": "us-east-1",
                }
            ]
        }
    )
    router = AIRouter(config)

    with pytest.raises(ProviderError) as exc_info:
        await router.embed(EmbeddingRequest(model="emb", input="test"))

    assert exc_info.value.kind == "invalid_request"
