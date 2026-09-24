"""Unit tests for streaming edge cases and error handling."""

import json

import pytest

from ai_router import ProviderError
from ai_router.http.sse import sse_data


@pytest.mark.asyncio
async def test_streaming_mid_stream_provider_error():
    async def mock_lines():
        yield 'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n\n'
        yield 'data: {"error":{"message":"overloaded"}}\n\n'

    chunks = []
    with pytest.raises(ProviderError) as exc_info:
        async for data in sse_data(mock_lines()):
            j = json.loads(data)
            if "error" in j:
                raise ProviderError("openai", "server", f"openai: {j['error']['message']}")
            chunks.append(j)

    assert len(chunks) == 1
    assert exc_info.value.kind == "server"
    assert "overloaded" in str(exc_info.value)
