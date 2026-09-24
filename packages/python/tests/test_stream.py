import pytest

from ai_router.stream import (
    collect_stream,
    stream_text,
    sync_collect_stream,
    sync_stream_text,
)
from ai_router.types import ChatChunk, Delta, Usage


async def sample_async_stream():
    yield ChatChunk(id="c1", model="test-m", delta=Delta(content="Hello"))
    yield ChatChunk(id="c2", model="test-m", delta=Delta(content=" world"))
    yield ChatChunk(
        id="c3",
        model="test-m",
        delta=Delta(content="!"),
        finish_reason="stop",
        usage=Usage(prompt_tokens=5, completion_tokens=3, total_tokens=8),
    )


def sample_sync_stream():
    yield ChatChunk(id="c1", model="test-m", delta=Delta(content="Hello"))
    yield ChatChunk(id="c2", model="test-m", delta=Delta(content=" sync"))
    yield ChatChunk(
        id="c3",
        model="test-m",
        delta=Delta(content="!"),
        finish_reason="stop",
        usage=Usage(prompt_tokens=4, completion_tokens=3, total_tokens=7),
    )


@pytest.mark.asyncio
async def test_async_stream_text():
    text = await stream_text(sample_async_stream())
    assert text == "Hello world!"


@pytest.mark.asyncio
async def test_async_collect_stream():
    chunks = await collect_stream(sample_async_stream())
    assert len(chunks) == 3
    assert chunks[0].id == "c1"
    assert chunks[0].delta.content == "Hello"
    assert chunks[2].finish_reason == "stop"
    assert chunks[2].usage is not None
    assert chunks[2].usage.total_tokens == 8


def test_sync_stream_text():
    text = sync_stream_text(sample_sync_stream())
    assert text == "Hello sync!"


def test_sync_collect_stream():
    chunks = sync_collect_stream(sample_sync_stream())
    assert len(chunks) == 3
    assert chunks[0].id == "c1"
    assert chunks[1].delta.content == " sync"
