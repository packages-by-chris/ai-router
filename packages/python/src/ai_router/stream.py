"""Stream collector utilities."""

from __future__ import annotations

from collections.abc import AsyncIterable, Iterable

from .types import ChatChunk


async def stream_text(stream: AsyncIterable[ChatChunk]) -> str:
    """Collect all text content from an async stream into a single string."""
    text = ""
    async for chunk in stream:
        if chunk.delta and chunk.delta.content:
            text += chunk.delta.content
    return text


async def collect_stream(stream: AsyncIterable[ChatChunk]) -> list[ChatChunk]:
    """Collect all chunks from an async stream into a list."""
    chunks: list[ChatChunk] = []
    async for chunk in stream:
        chunks.append(chunk)
    return chunks


def sync_stream_text(stream: Iterable[ChatChunk]) -> str:
    """Collect all text content from a sync stream into a single string."""
    text = ""
    for chunk in stream:
        if chunk.delta and chunk.delta.content:
            text += chunk.delta.content
    return text


def sync_collect_stream(stream: Iterable[ChatChunk]) -> list[ChatChunk]:
    """Collect all chunks from a sync stream into a list."""
    return list(stream)
