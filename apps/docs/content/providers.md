---
title: Providers
description: OpenAI, OpenAI-compatible, Anthropic, and Gemini adapters — behavior and defaults.
---

# Providers

Four provider ids are supported out of the box:

```ts
const PROVIDER_IDS = ["openai", "openai-compatible", "anthropic", "gemini"] as const;
```

## openai

Default base URL `https://api.openai.com/v1`. The unified surface mirrors
OpenAI chat completions, so this adapter is a thin pass-through.

```json
{ "id": "fast", "provider": "openai", "model": "gpt-4o-mini", "apiKey": "sk-..." }
```

## openai-compatible

Any OpenAI-shaped endpoint — DeepSeek, Groq, Together, vLLM, Ollama.
`baseUrl` is **required**:

```json
{ "id": "cheap", "provider": "openai-compatible",
  "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "apiKey": "..." }
```

## anthropic

Default base URL `https://api.anthropic.com/v1`, sends
`anthropic-version: 2023-06-01`. Adapter details handled for you:

- System messages are extracted from the unified message list into Anthropic's top-level `system` field.
- Tool definitions/results translate to `tool_use` / `tool_result` blocks in both directions.
- `max_tokens` defaults to **4096** when the request omits it (Anthropic requires it).
- HTTP 529 (overloaded) classifies as retryable.

## gemini

Default base URL
`https://generativelanguage.googleapis.com/v1beta`. Uses
`generateContent` / `streamGenerateContent?alt=sse`, translating roles,
system instruction, function calling (`functionCall` / `functionResponse`
parts), `generationConfig`, and finish reasons.

## Multimodal content

Unified content accepts text + image parts on any provider; translation is
per-provider. See [Multimodal](/docs/multimodal).

## Known limits of the unified layer

Anything not modeled by the unified types is deliberately **not** half-modeled
— thinking blocks, server tools, `json_schema` response formats, logprobs. Use
the [raw escape hatch](/docs/raw-requests) instead; rpm gating still applies
and the key cursor stays shared with unified calls.

## Custom providers

The adapter registry is currently fixed — unknown provider ids are rejected at
config-parse time (`UnsupportedProviderError`). Anything OpenAI-shaped belongs
behind `"openai-compatible"` with a `baseUrl`. The `ProviderAdapter` interface
is exported if you want to build against it, but runtime registration is not
exposed yet.
