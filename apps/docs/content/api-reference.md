---
title: API reference
description: The complete public surface of @ai-router/core and @ai-router/redis.
---

# API reference

Public surface of `@ai-router/core` — everything below is exported from the
package root.

## AIRouter

The facade you normally construct.

```ts
new AIRouter(configInput: RouterConfig | unknown, opts?: AIRouterOptions)
```

Accepts an already-validated config or raw unvalidated input; validation
errors aggregate into one `ConfigError`.

| Member | Signature | Notes |
| --- | --- | --- |
| `routes` | `get routes(): string[]` | Route ids available as `model` values. |
| `complete` | `(req: ChatRequest, opts?: CallOptions): Promise<ChatResponse>` | Walks the chain, returns a unified response. |
| `stream` | `(req: ChatRequest, opts?: CallOptions): Promise<AsyncIterable<ChatChunk>>` | Committed stream — see [Streaming](/docs/streaming). |
| `raw` | `(routeId: string, opts?: RawRequestOptions): Promise<Response>` | Escape hatch — see [Raw requests](/docs/raw-requests). |

`AIRouterOptions` extends `EngineOptions`:

| Option | Default | Purpose |
| --- | --- | --- |
| `store?` | `new MemoryStore()` | Rate-limit storage. |
| `fetchImpl?` | global `fetch` | Inject a mock in tests. |
| `sleep?` | `setTimeout` wrapper | Backoff injection for tests. |
| `rng?` | `Math.random` | Backoff jitter source. |

## CallOptions

```ts
interface CallOptions {
  onAttempt?: (event: AttemptEvent) => void;
}
```

Fires for every routing decision and retry — see [Routing](/docs/routing).

## Config types

- `RouterConfig` — `{ routes: ModelRoute[] }`
- `ModelRoute` — id, provider, model, apiKey/apiKeys, baseUrl, headers, maxRetries, timeoutMs, limit
- `LimitRule` — `{ rpm?, tpm? }`
- `PROVIDER_IDS` — `["openai", "openai-compatible", "anthropic", "gemini"]`
- `parseConfig(input: unknown): RouterConfig` — standalone validation, aggregated errors

## Unified request/response types

OpenAI-shaped, on purpose:

- **Requests** — `ChatRequest`, `ChatMessage`, `Role`, `Tool`, `ToolCall`,
  `ContentPart` (`TextPart` \| `ImageUrlPart`)
- **Responses** — `ChatResponse`, `Choice`, `Usage`
- **Streams** — `ChatChunk`, `Delta`, `ToolCallDelta`

Shapes are documented page by page under [Core concepts](/docs/configuration).

## Errors

`AIRouterError` (base), `ConfigError`, `UnsupportedProviderError`,
`ProviderError`, `RateLimitedError`, `AllRoutesFailedError`, plus helpers
`classifyStatus`, `isRetryableKind`, `isKeyRelatedKind`. Full taxonomy:
[Errors](/docs/errors).

## Routing engine

`RoutingEngine` is exported for advanced use (it is what `AIRouter` wraps),
along with `estimateTokens`, and the types `AttemptEvent`, `AttemptOutcome`,
`CallOptions`, `EngineOptions`.

## Rate limiting

- `MemoryStore` — default in-process sliding window.
- `RateLimitStore`, `RateLimitDecision` — the pluggable interface.

## HTTP + SSE utilities

- `fetchWithTimeout`, `parseRetryAfter`, `toNetworkError`, type `FetchLike`
- `sseData`, `streamFromChunks` — SSE parsing primitives

## Provider adapters + translation

Exported per provider for testing/custom pipelines:

- OpenAI: `OpenAIAdapter`, `OPENAI_DEFAULT_BASE_URL`, `translateRequest`, `translateResponse`, `translateChunk`
- Anthropic: `AnthropicAdapter`, `ANTHROPIC_DEFAULT_BASE_URL`, `ANTHROPIC_VERSION` (`2023-06-01`), `ANTHROPIC_DEFAULT_MAX_TOKENS` (4096), `translateAnthropicRequest`, `translateAnthropicResponse`, `mapAnthropicFinishReason`
- Gemini: `GeminiAdapter`, `GEMINI_DEFAULT_BASE_URL`, `translateGeminiRequest`, `translateGeminiResponse`, `mapGeminiFinishReason`
- Registry: `getAdapter`, `isSupported`; adapter types `ProviderAdapter`, `NormalizedRoute`, `AdapterContext`, `RawRequestOptions`

## @ai-router/redis

| Export | Kind |
| --- | --- |
| `RedisStore` | `RateLimitStore` over Redis ZSETs, Lua-atomic. Options: `client`, `prefix?`, `failOpen?`, `onError?`, `now?`. |
| `ioredisClient(client)` | Adapt ioredis to `RedisEvalClient`. |
| `nodeRedisClient(client)` | Adapt node-redis v4+ to `RedisEvalClient`. |
| `TAKE_SCRIPT`, `RECORD_SCRIPT` | The Lua scripts, exposed for audit/pipelining. |
| `RedisEvalClient` | Minimal interface: `eval(script, keys, args)` — implement for Upstash etc. |

Details: [Rate limiting](/docs/rate-limiting).
