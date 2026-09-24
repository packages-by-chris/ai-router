"""Live smoke test against real provider APIs for Python SDK.

Run manually with keys:
    OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=... python scripts/smoke.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# Add src to sys.path so we can run directly
sys.path.insert(0, str(Path(__file__).parent.parent / "packages" / "python" / "src"))

from ai_router import AIRouter, ChatMessage, ChatRequest

TARGETS = [
    {
        "provider": "openai",
        "envKey": "OPENAI_API_KEY",
        "route": {"id": "smoke", "provider": "openai", "model": "gpt-4o-mini", "maxRetries": 0},
    },
    {
        "provider": "anthropic",
        "envKey": "ANTHROPIC_API_KEY",
        "route": {"id": "smoke", "provider": "anthropic", "model": "claude-3-5-haiku-latest", "maxRetries": 0},
    },
    {
        "provider": "gemini",
        "envKey": "GEMINI_API_KEY",
        "route": {"id": "smoke", "provider": "gemini", "model": "gemini-2.0-flash", "maxRetries": 0},
    },
]

req = ChatRequest(
    model="smoke",
    messages=[ChatMessage(role="user", content="Reply with exactly: ok")],
    max_tokens=16,
)


async def smoke_complete(router: AIRouter) -> str:
    res = await router.complete(req)
    choice = res.choices[0] if res.choices else None
    text = choice.message.content if choice else None
    if not isinstance(text, str) or len(text) == 0:
        finish = choice.finish_reason if choice else None
        raise RuntimeError(f"empty completion content (finish={finish})")
    usage_tok = res.usage.total_tokens if res.usage else "?"
    return f"{repr(text[:40])} usage={usage_tok}tok"


async def smoke_stream(router: AIRouter) -> str:
    stream = await router.stream(req)
    chunks = 0
    finish: str | None = None
    text = ""
    async for chunk in stream:
        chunks += 1
        if chunk.delta.content:
            text += chunk.delta.content
        if chunk.finish_reason:
            finish = chunk.finish_reason
    if chunks == 0:
        raise RuntimeError("no chunks received")
    return f"{chunks} chunks, finish={finish}, text={repr(text[:40])}"


async def main() -> None:
    failures = 0
    ran = 0

    for target in TARGETS:
        key = os.getenv(target["envKey"])
        if not key:
            print(f"skip {target['provider']} ({target['envKey']} not set)")
            continue
        ran += 1
        route = dict(target["route"])
        route["apiKey"] = key
        router = AIRouter(config={"routes": [route]})

        try:
            complete_info = await smoke_complete(router)
            print(f"PASS {target['provider']} complete: {complete_info}")
        except Exception as err:
            failures += 1
            print(f"FAIL {target['provider']} complete: {err}")
            continue

        try:
            stream_info = await smoke_stream(router)
            print(f"PASS {target['provider']} stream:   {stream_info}")
        except Exception as err:
            failures += 1
            print(f"FAIL {target['provider']} stream:   {err}")

    print(f"\n{ran} provider(s) tested, {failures} failure(s)")
    if failures > 0:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
