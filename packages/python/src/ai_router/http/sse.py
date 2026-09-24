"""Minimal SSE parser over async byte/string streams.

Yields the payload of every `data:` field. Event/id/retry fields and `:` comments
are ignored. Handles CRLF, multi-line data fields, and block boundaries split
across network chunks.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterable, AsyncIterator


def _next_boundary(buf: str) -> tuple[int, int] | None:
    lf = buf.find("\n\n")
    crlf = buf.find("\r\n\r\n")
    if lf == -1 and crlf == -1:
        return None
    if crlf == -1 or (lf != -1 and lf < crlf):
        return (lf, 2)
    return (crlf, 4)


def _extract_data(block: str) -> str | None:
    lines = re.split(r"\r?\n", block)
    data_lines: list[str] = []
    for line in lines:
        if line.startswith("data:"):
            value = line[5:]
            value = value.removeprefix(" ")
            data_lines.append(value)
    if not data_lines:
        return None
    return "\n".join(data_lines)


async def sse_data(stream: AsyncIterable[bytes | str]) -> AsyncIterator[str]:
    """Asynchronously parses an SSE stream into data payloads."""
    buffer = ""
    async for chunk in stream:
        if isinstance(chunk, bytes):
            buffer += chunk.decode("utf-8", errors="replace")
        else:
            buffer += chunk

        while True:
            boundary = _next_boundary(buffer)
            if boundary is None:
                break
            idx, length = boundary
            block = buffer[:idx]
            buffer = buffer[idx + length :]
            data = _extract_data(block)
            if data is not None:
                yield data

    tail = _extract_data(buffer)
    if tail is not None:
        yield tail


async def stream_from_chunks(parts: list[str]) -> AsyncIterator[str]:
    """Helper for tests and conformance fixtures: yields parts asynchronously."""
    for part in parts:
        yield part
