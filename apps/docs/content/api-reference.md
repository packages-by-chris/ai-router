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
| `embed` | `(req: EmbeddingRequest, opts?: CallOptions): Promise<EmbeddingResponse>` | Embeddings with the same fallback machinery. |
| `raw` | `(routeId: string, opts?: RawRequestOptions): Promise<Response>` | Escape hatch — see [Raw requests](/docs/raw-requests). |
| `explain` | `(req: ChatRequest, opts?): Promise<RoutingExplanation>` | Dry-run decision: candidates, reasons, estimated cost — see [Dry-run](/docs/dry-run). |
| `recordOutcome` | `(event: OutcomeEvent): void` | Record app-observed quality for adaptive routing. |
| `stats` | `(): Promise<RouterStats>` | Circuit breakers, key cursors, health percentiles, outcomes. |

`AIRouterOptions` extends `EngineOptions`:

| Option | Default | Purpose |
| --- | --- | --- |
| `store?` | `new MemoryStore()` | Rate-limit storage. |
| `fetchImpl?` | global `fetch` | Inject a mock in tests. |
| `sleep?` | `setTimeout` wrapper | Backoff injection for tests. |
| `rng?` | `Math.random` | Backoff jitter source. |
| `middleware?` | — | Per-attempt lifecycle hooks ([Middleware](/docs/middleware)). |
| `circuitBreaker?` | disabled | Skip route after N failures ([Circuit breaker](/docs/circuit-breaker)). |
| `pricing?` | — | USD per 1M tokens by route/model id — enables cost routing ([Cost, latency & quality](/docs/routing-policies)). |

## CallOptions

```ts
interface CallOptions {
  onAttempt?: (event: AttemptEvent) => void;
  onFinish?: (summary: CallSummaryEvent) => void;
  onLog?: (event: LogEvent) => void;
  signal?: AbortSignal;
  deadlineMs?: number;        // whole-call wall-clock budget
  routing?: RoutingOptions;   // per-call routing policy
}
```

- `onAttempt` — fires for every routing decision and retry — see [Routing](/docs/routing).
- `onFinish` — fires exactly once when the call settles (usage, cost, latency).
- `onLog` — structured lifecycle events; fires in addition to any
  engine-level hook — see [Observability](/docs/observability).
- `signal` — caller-provided abort signal. Cancels in-flight requests when fired.
- `deadlineMs` — wall-clock budget across retries/fallbacks; breach throws
  `DeadlineExceededError` — see [Deadlines](/docs/deadlines).
- `routing` — per-call policy knobs:

```ts
interface RoutingOptions {
  require?: CapabilityRequirement; // hard capability constraints
  task?: string;                   // quality-first bucket
  maxCostUsd?: number;             // estimated-cost ceiling
  maxLatencyMs?: number;           // observed-p50 ceiling
  filter?: (route: RouteView) => boolean; // secret-free view
}
```

See [Capability routing](/docs/capability-routing) and
[Cost, latency & quality](/docs/routing-policies).

## Middleware

```ts
interface Middleware {
  beforeRequest?: (ctx: RequestContext) => Promise<void> | void;
  afterResponse?: (ctx: RequestContext, response: ChatResponse) => Promise<void> | void;
}

interface RequestContext {
  routeId: string;
  provider: string;
  model: string;       // provider-side model name
  request: ChatRequest;
  attempt: number;     // 1-based
}
```

Per-attempt lifecycle hooks — see [Middleware](/docs/middleware).

## Circuit breaker

```ts
// Passed as EngineOptions.circuitBreaker
{ threshold?: number; cooldownMs?: number; maxCooldownMs?: number }
```

Skip routes after consecutive failures — see [Circuit breaker](/docs/circuit-breaker).

## Guardrails

```ts
// Passed as EngineOptions.guardrails — see [Guardrails](/docs/guardrails)
{
  input?: InputGuardrail[];   // check(req) -> verdict, before routing
  output?: OutputGuardrail[]; // check(res) -> verdict, after complete()
}

interface GuardrailVerdict {
  pass?: boolean;
  reason?: string;
  replace?: unknown;
}
```

Blocking throws `GuardrailBlockedError` (extends `AIRouterError`) with
`phase`, `guardrail`, and `reason`.

## Observability

```ts
// EngineOptions.onLog / CallOptions.onLog
type LogEvent =
  | { type: "call_start"; ts; op; model }
  | { type: "cache_hit"; ts; model }
  | { type: "route_skip"; ts; routeId; provider; reason }
  | { type: "attempt_retry"; ts; routeId; provider; attempt; kind?; delayMs? }
  | { type: "guardrail_block"; ts; phase; guardrail; reason? };
```

See [Observability](/docs/observability) for the full event reference.

## Config types

- `RouterConfig` — `{ routes, strategy?: "fallback" | "round-robin" | "weighted" | "least-latency" }`
- `ModelRoute` — id, provider, model, apiKey/apiKeys, baseUrl, apiVersion (azure), region (bedrock/vertex), project (vertex), headers, maxRetries, timeoutMs, streamIdleTimeoutMs, limit, budget, weight
- `LimitRule` — `{ rpm?, tpm? }`
- `BudgetRule` — `{ usd, windowMs? }`
- `PROVIDER_IDS` — built-in adapters: `["openai", "openai-compatible", "azure", "anthropic", "gemini", "bedrock", "vertex"]`
- `PROVIDER_PRESETS`, `getPreset` — the preset catalog (groq, deepseek, ollama, …)
- `registerAdapter(id, create)`, `knownProviderIds()` — third-party provider registration
- `parseConfig(input: unknown, env?: Record<string, string | undefined>): RouterConfig` — standalone validation, aggregated errors, `${ENV_VAR}` interpolation

## Unified request/response types

OpenAI-shaped, on purpose:

- **Requests** — `ChatRequest` (incl. `reasoning_effort`, `response_format`
  with `json_schema`, `providerOptions`), `ChatMessage` (incl.
  `reasoning`, message-level `providerOptions`), `Role`, `Tool`, `ToolCall`,
  `ContentPart` (`TextPart` \| `ImageUrlPart`), `ResponseFormat`,
  `ProviderOptions`
- **Responses** — `ChatResponse`, `Choice`, `Usage` (incl. `cached_tokens`,
  `cache_write_tokens`, `reasoning_tokens`), `TokenPrice` (with optional
  `cache_read` / `cache_write` tiers)
- **Streams** — `ChatChunk`, `Delta` (incl. `reasoning`), `ToolCallDelta`

Shapes are documented page by page under [Core concepts](/docs/configuration).

## Errors

`AIRouterError` (base), `ConfigError`, `UnsupportedProviderError`,
`ProviderError`, `RateLimitedError`, `AllRoutesFailedError`,
`DeadlineExceededError`, plus helpers
`classifyStatus`, `isRetryableKind`, `isKeyRelatedKind`. Full taxonomy:
[Errors](/docs/errors).

## Routing engine

`RoutingEngine` is exported for advanced use (it is what `AIRouter` wraps),
along with `estimateTokens`, `computeCost`, and the types `AttemptEvent`,
`AttemptOutcome`, `CallSummaryEvent`, `CallOptions` (with `onFinish`),
`EngineOptions` (incl. `pricing`, `responseCache`, `circuitBreaker.maxCooldownMs`),
`Middleware`, `RequestContext`, `RouterStats`.

## Conformance kit

- `runTranslationCases(cases, handlers?)`, `runTranslationCase`, `stableJson`
- Types: `TranslationCase`, `TranslationHandlers`, `CaseResult`
- For third-party adapter authors proving translation parity — see
  [Conformance](/docs/conformance).

## Stream utilities

- `streamText(stream)` — collects all content chunks into a `Promise<string>`
- `collectStream(stream)` — collects all chunks into a `Promise<ChatChunk[]>`

## Rate limiting

- `MemoryStore` — default in-process sliding window.
- `RateLimitStore`, `RateLimitDecision` — the pluggable interface.

## HTTP + SSE utilities

- `fetchWithTimeout`, `parseRetryAfter`, `toNetworkError`, type `FetchLike`
- `sseData`, `streamFromChunks` — SSE parsing primitives

## Provider adapters + translation

Exported per provider for testing/custom pipelines:

- OpenAI: `OpenAIAdapter`, `OPENAI_DEFAULT_BASE_URL`, `translateRequest`, `translateResponse`, `translateChunk`, `mergeProviderOptions`, `usageDetails`
- Azure: `AzureAdapter`, `AZURE_DEFAULT_API_VERSION`
- Anthropic: `AnthropicAdapter`, `ANTHROPIC_DEFAULT_BASE_URL`, `ANTHROPIC_VERSION` (`2023-06-01`), `ANTHROPIC_DEFAULT_MAX_TOKENS` (4096), `ANTHROPIC_THINKING_BUDGETS`, `translateAnthropicRequest`, `translateAnthropicResponse`, `mapAnthropicFinishReason`
- Gemini: `GeminiAdapter`, `GEMINI_DEFAULT_BASE_URL`, `GEMINI_THINKING_BUDGETS`, `translateGeminiRequest`, `translateGeminiResponse`, `mapGeminiFinishReason`
- Registry: `getAdapter`, `isSupported`, `registerAdapter`, `knownProviderIds`; adapter types `ProviderAdapter`, `NormalizedRoute`, `AdapterContext`, `RawRequestOptions`

## @ai-router/redis

| Export | Kind |
| --- | --- |
| `RedisStore` | `RateLimitStore` over Redis ZSETs, Lua-atomic. Options: `client`, `prefix?`, `failOpen?`, `onError?`, `now?`. |
| `ioredisClient(client)` | Adapt ioredis to `RedisEvalClient`. |
| `nodeRedisClient(client)` | Adapt node-redis v4+ to `RedisEvalClient`. |
| `TAKE_SCRIPT`, `RECORD_SCRIPT`, `USED_SCRIPT` | The Lua scripts, exposed for audit/pipelining. `used()` powers budget pre-flight checks. |
| `RedisEvalClient` | Minimal interface: `eval(script, keys, args)` — implement for Upstash etc. |

Details: [Rate limiting](/docs/rate-limiting).
