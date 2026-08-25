---
title: Providers
description: Built-in adapters, the preset catalog, and third-party adapter registration.
---

# Providers

A route's `provider` resolves in three ways, checked in order:

1. **Built-in adapters** — native wire protocols.
2. **Preset catalog** — vendors serving OpenAI-compatible APIs; baseUrl and
   auth are resolved for you from data.
3. **Registered adapters** — third-party `ProviderAdapter` implementations
   via `registerAdapter` (the `@ai-sdk/*` pattern).

## Built-in adapters

```ts
const PROVIDER_IDS = ["openai", "openai-compatible", "azure", "anthropic", "gemini"] as const;
```

### openai

Default base URL `https://api.openai.com/v1`. The unified surface mirrors
OpenAI chat completions, so this adapter is a thin pass-through.

```json
{ "id": "fast", "provider": "openai", "model": "gpt-4o-mini", "apiKey": "sk-..." }
```

### openai-compatible

Any OpenAI-shaped endpoint. `baseUrl` is **required**:

```json
{ "id": "cheap", "provider": "openai-compatible",
  "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "apiKey": "..." }
```

### azure

Azure OpenAI reuses the OpenAI translation behind a different URL layout and
auth header. `model` is the **deployment name**, `baseUrl` is the resource
root, and `apiVersion` is required:

```json
{ "id": "az", "provider": "azure",
  "baseUrl": "https://my-res.openai.azure.com",
  "apiVersion": "2024-10-21",
  "model": "gpt-4o-deploy", "apiKey": "..." }
```

Requests go to
`{baseUrl}/openai/deployments/{model}/chat/completions?api-version=...` with
an `api-key` header.

### anthropic

Default base URL `https://api.anthropic.com/v1`, sends
`anthropic-version: 2023-06-01`. Adapter details handled for you:

- System messages are extracted into Anthropic's top-level `system` field.
- Tool definitions/results translate to `tool_use` / `tool_result` blocks in both directions.
- `max_tokens` defaults to **4096** when the request omits it (Anthropic requires it).
- HTTP 529 (overloaded) classifies as retryable.
- `reasoning_effort` maps to a thinking budget (low 4k / medium 12k / high 24k
  tokens); thinking text surfaces as `message.reasoning` and `delta.reasoning`
  in streams. Sampling params are dropped while thinking is active (API constraint).
- Message-level `providerOptions.anthropic.cache_control: true` stamps an
  ephemeral prompt-cache breakpoint on that message's last block; cache
  read/write tokens appear on `Usage`.

### gemini

Default base URL
`https://generativelanguage.googleapis.com/v1beta`. Uses
`generateContent` / `streamGenerateContent?alt=sse`, translating roles,
system instruction, function calling (`functionCall` / `functionResponse`
parts), `generationConfig`, and finish reasons. `reasoning_effort` maps to
`thinkingConfig.thinkingBudget`; thought parts surface as reasoning;
`response_format: json_schema` becomes `responseMimeType` +
`responseJsonSchema`.

## Preset catalog

~20 vendors serve an OpenAI-compatible API and differ only in URL/auth. Use
the preset id as `provider` and skip `baseUrl` entirely:

```json
{ "id": "fast", "provider": "groq", "model": "llama-3.3-70b-versatile",
  "apiKey": "${GROQ_API_KEY}" }
```

Presets: groq, deepseek, mistral, openrouter, together, fireworks,
perplexity, xai, cerebras, sambanova, cohere, deepinfra, nvidia,
github-models, hyperbolic, novita, nebius, lambda — plus keyless local
runtimes (**ollama**, **lmstudio**, **vllm**), which may omit
`apiKey`/`apiKeys` entirely.

Explicit `baseUrl` / `headers` on the route always override preset values.
The catalog lives in `PROVIDER_PRESETS` and is plain data — extendable at
runtime if you need a vendor we do not list.

## Structured output & reasoning

`response_format: { type: "json_schema", json_schema: { schema } }` works on
OpenAI-family routes natively and Gemini via `responseJsonSchema`; Anthropic
has no equivalent, so it is dropped there. `reasoning_effort` maps per
provider (see above); unsupported providers ignore it.

## Multimodal content

Unified content accepts text + image parts on any provider; translation is
per-provider. See [Multimodal](/docs/multimodal).

## Known limits of the unified layer

Anything not modeled by the unified types is deliberately **not** half-modeled:
logprobs, server-side tools (web search, code interpreter), Gemini 3
`thoughtSignature` round-tripping, audio/image generation. Use the
[raw escape hatch](/docs/raw-requests) or request-level
[`providerOptions`](/docs/api-reference) instead — both keep retries,
fallback, rate limiting, and key rotation intact (`raw` keeps only rpm
gating).

## Custom providers

Register a third-party adapter under any id, then use it like a built-in:

```ts
import { registerAdapter, knownProviderIds } from "@ai-router/core";
import { BedrockAdapter } from "@ai-router/provider-bedrock";

registerAdapter("bedrock", () => new BedrockAdapter());
// knownProviderIds() now includes "bedrock"; configs may declare it.
```

External adapters can prove their translation with the exported conformance
kit — see [Conformance](/docs/conformance).
