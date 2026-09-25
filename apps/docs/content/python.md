---
title: Python SDK
description: The Python SDK for ai-router-sdk — synchronous & async APIs, 100% behavioral parity with TypeScript, zero mandatory dependencies.
---

# Python SDK

`ai-router-sdk` includes a native Python package with 1:1 behavioral parity with the TypeScript core. It is built strictly on Python 3.10+ standard libraries (`urllib`, `dataclasses`, `asyncio`), with zero mandatory external runtime dependencies.

## Installation

```bash
pip install ai-router-sdk
```

Optional extras:
```bash
pip install "ai-router-sdk[redis]"   # Redis distributed state and limiter store
pip install "ai-router-sdk[httpx]"   # Alternative HTTP client adapter
```

## API Surface

`AIRouter` exposes both synchronous (`*_sync`) and asynchronous (`async`/`await`) methods:

```python
from ai_router import AIRouter

router = AIRouter(
    config={
        "strategy": "fallback",
        "routes": [
            {
                "id": "fast",
                "provider": "openai",
                "model": "gpt-4o-mini",
                "apiKey": "${OPENAI_API_KEY}",
                "limit": {"rpm": 100},
            },
            {
                "id": "fallback-claude",
                "provider": "anthropic",
                "model": "claude-3-5-haiku-20241022",
                "apiKey": "${ANTHROPIC_API_KEY}",
            },
        ],
    }
)
```

### 1. Synchronous Methods

```python
# Completion
response = router.complete_sync({
    "model": "fast",
    "messages": [{"role": "user", "content": "Explain relativity in one sentence."}],
})
print(response.choices[0].message.content)

# Streaming
stream = router.stream_sync({
    "model": "fast",
    "messages": [{"role": "user", "content": "Count from 1 to 5."}],
})
for chunk in stream:
    if chunk.delta and chunk.delta.content:
        print(chunk.delta.content, end="", flush=True)
```

### 2. Asynchronous Methods

```python
import asyncio

async def main():
    # Async completion
    response = await router.complete({
        "model": "fast",
        "messages": [{"role": "user", "content": "Hello async router!"}],
    })
    print(response.choices[0].message.content)

    # Async streaming
    async for chunk in await router.stream({
        "model": "fast",
        "messages": [{"role": "user", "content": "Stream this async."}],
    }):
        if chunk.delta and chunk.delta.content:
            print(chunk.delta.content, end="", flush=True)

asyncio.run(main())
```

## Supported Features in Python

- **Cross-SDK Conformance**: Validated against the identical 38 test suites in `conformance/cases/*.json`.
- **All 7 Routing Strategies**: `fallback`, `round-robin`, `weighted`, `least-latency`, `cheapest`, `balanced`, and `quality-first`.
- **Sliding-Window Rate Limiting & Budgets**: In-memory token bucket + optional Redis backend (`ai-router-sdk[redis]`).
- **Telemetry & Explain**: `router.explain(...)` dry-run inspections, `router.record_outcome(...)` for adaptive feedback, and lifecycle event callbacks.
