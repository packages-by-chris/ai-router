# ai-router-sdk (Python)

**Embeddable, provider-agnostic AI routing engine for Python.**

`ai-router-sdk` provides the routing, reliability, and governance capabilities of an AI gateway without requiring a separate proxy service. It runs directly inside your Python application, talks to providers over their native APIs, and handles:

- **Ordered fallback chains** across models and providers.
- **Smart routing strategies**: `fallback`, `round-robin`, `weighted`, `least-latency`, `cheapest`, `balanced`, `quality-first`.
- **Sliding-window rate limiting** (RPM / TPM) & **spend budget caps** (USD).
- **Statistical health tracking** (Wilson lower-bound scoring, latency percentiles, EWMA decay).
- **Key-pool rotation & circuit breaking**.
- **Unified streaming & response parsing** across all major wire protocols.
- **Input / Output Guardrails** and **Offline Strategy Replay**.
- **Zero mandatory runtime dependencies** — built with Python standard library (`urllib`, `dataclasses`, `asyncio`).

---

## Installation

```bash
pip install ai-router-sdk
```

### Optional Extras
- **Redis state store**: `pip install "ai-router-sdk[redis]"`
- **HTTPX client support**: `pip install "ai-router-sdk[httpx]"`

---

## Quick Start

### 1. Synchronous Usage

```python
from ai_router import AIRouter

router = AIRouter(
    config={
        "routes": [
            {
                "id": "fast",
                "provider": "openai",
                "model": "gpt-4o-mini",
                "apiKey": "${OPENAI_API_KEY}",
                "limit": {"rpm": 120},
            },
            {
                "id": "backup",
                "provider": "anthropic",
                "model": "claude-3-5-haiku-20241022",
                "apiKey": "${ANTHROPIC_API_KEY}",
            },
        ]
    }
)

# Non-streaming completion
response = router.complete_sync(
    {
        "model": "fast",
        "messages": [{"role": "user", "content": "What is the capital of France?"}],
    }
)
print(response.choices[0].message.content)

# Streaming
for chunk in router.stream_sync(
    {
        "model": "fast",
        "messages": [{"role": "user", "content": "Explain quantum computing in 2 sentences."}],
    }
):
    if chunk.delta.content:
        print(chunk.delta.content, end="", flush=True)
print()
```

### 2. Async Usage

```python
import asyncio
from ai_router import AIRouter, ChatRequest, ChatMessage


async def main():
    router = AIRouter(
        config={
            "routes": [
                {"id": "primary", "provider": "gemini", "model": "gemini-2.0-flash", "apiKey": "${GEMINI_API_KEY}"},
                {
                    "id": "secondary",
                    "provider": "groq",
                    "model": "llama-3.3-70b-versatile",
                    "apiKey": "${GROQ_API_KEY}",
                },
            ]
        }
    )

    req = ChatRequest(
        model="primary",
        messages=[ChatMessage(role="user", content="Hello!")],
    )

    # Complete
    res = await router.complete(req)
    print(res.choices[0].message.content)

    # Stream
    async for chunk in await router.stream(req):
        if chunk.delta.content:
            print(chunk.delta.content, end="", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
```

---

## Features & Capabilities

### Multi-Provider Support

`ai-router` provides native wire-format adapters and 30+ built-in presets:

| Provider | Preset / Adapter | Native Wire Translation |
|---|---|---|
| **OpenAI** | `openai` | Chat Completions, JSON schema, Tools, SSE |
| **Anthropic** | `anthropic` | Messages API, Thinking Budget, Prompt Caching |
| **Google Gemini** | `gemini` | `generateContent`, `streamGenerateContent` |
| **AWS Bedrock** | `bedrock` | Converse API, SigV4 signing, Binary Event Stream |
| **Google Vertex AI** | `vertex` | Regional endpoints, OAuth2 service account JWT token auth |
| **Azure OpenAI** | `azure` | Resource & deployment routing |
| **OpenAI-Compatible** | `groq`, `together`, `deepseek`, `mistral`, `openrouter`, `ollama`, ... | 30+ pre-configured provider presets |

### Routing Strategies

Configure how routes in a chain are ordered dynamically:

```json
{
  "strategy": "balanced",
  "policy": {
    "weights": { "cost": 0.4, "latency": 0.4, "quality": 0.2 },
    "maxCostUsd": 0.005,
    "maxLatencyMs": 1500
  }
}
```

- **`fallback`**: Sequential failover in order of declaration.
- **`round-robin`**: Distribute traffic evenly across healthy routes.
- **`weighted`**: Probabilistic routing based on route weights.
- **`least-latency`**: Order by observed per-operation latency (complete vs stream TTFB).
- **`cheapest`**: Order by declared token pricing.
- **`balanced`**: Composite score combining cost, latency, and quality with Wilson lower-bound reliability.
- **`quality-first`**: Order by recorded application outcomes (`router.record_outcome(...)`).

### Reliability & Resilience

- **Sliding-Window Rate Limiting**: Enforce pre-flight RPM and post-flight TPM constraints.
- **Spend Budgets**: Rolling USD spending limits.
- **Key-Pool Rotation**: Automatically rotate through `apiKeys` lists on rate-limit (429) or auth errors.
- **Circuit Breaker**: Skip routes experiencing repeated consecutive failures.
- **Input & Output Guardrails**: Intercept, validate, or redact prompts and responses.

---

## Stream Utilities

```python
from ai_router import AIRouter, stream_text, collect_stream

router = AIRouter(...)

# Extract raw text stream directly
async for text_piece in stream_text(await router.stream(req)):
    print(text_piece, end="", flush=True)

# Collect an entire stream into a unified ChatResponse
response = await collect_stream(await router.stream(req))
print(f"Total tokens used: {response.usage.total_tokens}")
```

---

## Development & Testing

```bash
# Run unit & integration tests
pytest packages/python/tests

# Run cross-SDK conformance fixtures
pytest packages/python/tests/test_conformance.py

# Run type checker (strict mode)
mypy packages/python/src
pyright packages/python

# Run live provider smoke tests (requires API keys)
OPENAI_API_KEY=... python scripts/smoke.py
```

## License

MIT
