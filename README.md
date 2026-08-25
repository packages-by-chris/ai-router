# ai-router

**An embeddable, provider-agnostic AI routing engine for TypeScript.**

ai-router runs inside your application process — not beside it as a service.
You declare routes across providers, and it handles the operational work of
talking to them: fallback chains, retries, key-pool rotation, rate limiting,
budgets, circuit breaking, and unified streaming. Your keys never leave your
process.

```
┌──────────────┐
│ Application  │
└──────┬───────┘
       │  complete() · stream() · embed() · raw()
       ▼
┌──────────────────────────────────────────────────┐
│                   ai-router                      │
│                                                  │
│   guardrails → cache → strategy selection        │
│        → rate limit / budget → circuit breaker   │
│        → retry → key rotation → next route       │
│                                                  │
│   provider adapters (unified request/response)   │
└──────┬─────────┬─────────┬─────────┬─────────────┘
       ▼         ▼         ▼         ▼
    OpenAI   Anthropic    Gemini   any OpenAI-compatible API
                                (Azure, Bedrock, Vertex, Groq,
                                 DeepSeek, Ollama, …)
```

**Status:** v0.1.0, pre-release. The TypeScript core is feature-complete for
its scope and covered by mock-based tests plus shared conformance fixtures.
A Python SDK built against the same fixtures is planned but does not exist
yet. The package is not yet published to npm.

## What it is

`@ai-router/core` is a client-side library that sits between your application
code and AI provider APIs:

- **In-process.** No gateway to deploy, no extra network hop, no vendor
  holding your keys or your traffic.
- **Provider abstraction.** One unified request/response shape (OpenAI-style,
  the de facto lingua franca) translated per provider in both directions.
- **Route-oriented.** Requests address a logical route id (`model: "fast"`),
  never a raw provider model name. Routes are ordered into fallback chains.
- **Zero runtime dependencies.** Only `fetch`, WebStreams, and WebCrypto.
  Runs on Node 18+, Bun, Deno, and edge runtimes.
- **Optional infrastructure.** Everything stateful is pluggable: rate-limit
  storage defaults to in-process and accepts a Redis-backed store when you
  outgrow one replica.

## Why it exists

Hosted AI gateways solve reliability by inserting a service between you and
the provider. That adds a hop, an operator, a bill, and a third party
terminating your credentials. Many applications don't need any of that — they
need the *logic* of a gateway (fallback, rotation, throttling, cost caps)
embedded directly in the app.

ai-router is that logic as a library:

| | Hosted gateway | Proxy server (LiteLLM) | ai-router |
| --- | --- | --- | --- |
| Runs | Vendor's cloud | A service you operate | In your process |
| Provider keys | Often theirs / proxied | Yours, stored server-side | Yours, never leave the app |
| Extra network hop | Yes | Yes | None |
| Language | Any (HTTP) | Python-centric | TypeScript-native |
| Failure domain | Vendor + your app | Proxy + your app | Your app only |

Choose ai-router when you want routing behavior as part of your TypeScript
codebase rather than another piece of infrastructure to run.

## Quick start

```bash
npm install @ai-router/core
```

```ts
import { AIRouter } from "@ai-router/core";

const router = new AIRouter({
  routes: [
    { id: "fast", provider: "openai", model: "gpt-4o-mini",
      apiKey: "${OPENAI_API_KEY}", limit: { rpm: 60 } },
    // Preset providers resolve base URL and auth style for you:
    { id: "backup", provider: "deepseek", model: "deepseek-chat",
      apiKey: "${DEEPSEEK_API_KEY}" },
  ],
});

// `model` is a route id. If "fast" fails, "backup" serves the request.
const res = await router.complete({
  model: "fast",
  messages: [{ role: "user", content: "hi" }],
});
console.log(res.choices[0].message.content);
console.log(res.provider); // which route actually served it
```

`${ENV_VAR}` strings are interpolated by `parseConfig` against `process.env`
(or an explicit env map). You can also pass plain `apiKey` values directly.

Streaming:

```ts
const stream = await router.stream({
  model: "fast",
  messages: [{ role: "user", content: "hi" }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.delta.content ?? "");
}
```

## Core features

- **Unified API surface** — `complete()`, `stream()`, `embed()` share the
  same routing machinery; responses carry the serving `provider`.
- **Fallback chains** — ordered routes; a request tries route *i*, then
  *i+1*, … until one succeeds.
- **Retries with backoff** — exponential backoff (400 ms base, 8 s cap, 25%
  jitter), honoring provider `Retry-After` as a floor.
- **Key-pool rotation** — multiple keys per route, rotated round-robin on
  rate-limit/auth/permission errors.
- **Rate limiting** — per-route rpm (pre-flight) and tpm (accounted post-hoc
  from provider usage reports) over a 60 s sliding window.
- **Spend budgets** — rolling USD budget per route, enforced pre-flight from
  recorded spend, priced via configurable token rates.
- **Circuit breaking** — skip a route after N consecutive failures, with
  graduated cooldowns up to a cap.
- **Streaming** — committed streams with SSE parsing for every wire format;
  usage arrives on the final chunk.
- **Guardrails** — input/output validators that block or rewrite traffic.
- **Observability** — structured lifecycle events, per-attempt hooks,
  end-of-call summaries with TTFB, usage, and cost.
- **Raw escape hatch** — send anything the unified layer doesn't model
  straight to the provider endpoint.

## Routing strategies

Configured at the top level with `strategy`. Strategies reorder the fallback
chain start; tail routes still serve if the chosen start fails.

| Strategy | Selection |
| --- | --- |
| `"fallback"` *(default)* | Strict config order — primary until it fails. |
| `"round-robin"` | Each request rotates the chain start cyclically. |
| `"weighted"` | Start picked proportionally to route `weight`, then falls back in order. |
| `"least-latency"` | Fastest-first by per-route latency EMA of observed successes; unobserved routes are sampled first. |

Latency tracking is in-process (per engine instance). See
[Current limitations](#current-limitations).

## Reliability

Three recovery layers run in order before a request fails:

1. **Retry same route + key** — retryable error kinds (`rate_limit`,
   `server`, `network`, `timeout`) get exponential backoff. Per-route
   `maxRetries` (default 2) and `timeoutMs` (default 30 s).
2. **Rotate key** — `rate_limit` / `auth` / `permission` errors try the next
   key in the pool immediately; the cursor spreads successive requests
   across the pool.
3. **Next route** — exhausted routes fall through the chain. Total failure
   throws `AllRoutesFailedError` carrying the full attempt trail (route,
   key index, error kind, message, `Retry-After`) for logging and retries.

Additional layers:

- **Circuit breaker** (`circuitBreaker: { threshold, cooldownMs,
  maxCooldownMs }`) — after `threshold` consecutive failures a route is
  skipped for `cooldownMs`. Each breach doubles the cooldown up to
  `maxCooldownMs` when set; fixed otherwise.
- **Budgets** (`budget: { usd, windowMs }`) — actual cost is recorded
  post-hoc in micro-dollar integers (requires `pricing` and a store with
  read-back). Once the window's spend reaches the cap, the route is skipped
  pre-flight and traffic falls through. Stores without read-back fail open.
- **Caller cancellation** — an aborted `signal` propagates immediately:
  no retry, no key rotation, no fallback.
- **Streaming commit boundary** — `stream()` resolves only after the first
  chunk has arrived, so the serving route is final. Errors before the first
  token are fallback-eligible; errors after commit surface to the caller.
  A provider swap mid-stream is impossible. Optional `streamIdleTimeoutMs`
  detects stalled streams on both sides of the boundary.

Error classification drives all of this; see `errors.ts` — every failure is
a typed `ProviderError` with a `kind` from a closed taxonomy
(`rate_limit`, `auth`, `permission`, `not_found`, `invalid_request`,
`server`, `network`, `timeout`, `unknown`).

## Providers

Built-in adapters implement each provider's native wire protocol:

| Adapter | Notes |
| --- | --- |
| `openai` / `openai-compatible` | Chat completions, embeddings, SSE streaming |
| `anthropic` | Typed SSE events, tool blocks, system extraction, prompt-cache markers |
| `gemini` | `generateContent` + `streamGenerateContent?alt=sse`, function calling |
| `azure` | Azure OpenAI deployment URLs, `api-key` auth, required `apiVersion` |
| `bedrock` | Converse API, SigV4 signing over WebCrypto, event-stream parsing |
| `vertex` | Regional Vertex endpoints, service-account JWT exchange over WebCrypto |

### Presets

Most vendors serve OpenAI-compatible APIs; those are data, not adapters.
30+ presets ship built in — groq, deepseek, mistral, together, fireworks,
perplexity, xai, cerebras, openrouter, cohere, sambanova, nvidia,
github-models, and more — plus keyless local runtimes (`ollama`, `lmstudio`,
`vllm`). A preset resolves adapter + base URL + auth style from the provider
id alone:

```ts
{ id: "fast", provider: "groq", model: "llama-3.3-70b-versatile",
  apiKey: "${GROQ_API_KEY}" }
{ id: "local", provider: "ollama", model: "llama3.2" }  // no key needed
```

Explicit `baseUrl` / `headers` on the route always win over preset values.

### Unified surface highlights

- Multimodal content parts (`text`, `image_url` with http(s)/data URIs),
  translated per provider.
- Tool calling with unified tool-call/tool-result translation in requests,
  responses, and streams.
- `response_format` (`json_object` / `json_schema` where supported),
  `reasoning_effort` mapped to each provider's thinking controls, and
  reasoning text surfaced on messages and stream deltas.
- Usage detail (`cached_tokens`, `cache_write_tokens`, `reasoning_tokens`)
  and tiered pricing (`cache_read`, `cache_write`).
- `providerOptions` — per-request extras merged into a specific provider's
  wire body while keeping translation/retries/fallback (unlike `raw()`):

```ts
router.complete({
  model: "smart",
  messages,
  providerOptions: {
    openai: { parallel_tool_calls: false },
    anthropic: { metadata: { user_id: "u1" } },
  },
});
```

Anything still outside the unified layer goes through `router.raw(routeId, {
path?, body?, headers?, method?, signal? })`, which returns the undecorated
provider `Response`. Raw calls get rpm gating and share the key cursor, but
no retries or fallback.

## Configuration

Configs are JSON-serializable objects validated by `parseConfig`, which
collects all violations into one `ConfigError` with JSON-path locations.
Pass raw input (e.g. a loaded JSON file) to `new AIRouter(...)` and it is
validated on construction.

```ts
interface RouterConfig {
  routes: ModelRoute[];   // ordered fallback chain
  strategy?: "fallback" | "round-robin" | "weighted" | "least-latency";
}
```

Route fields:

| Field | Meaning |
| --- | --- |
| `id` | Logical name used as `model` in requests. Unique. |
| `provider` | Built-in adapter, preset id, or registered custom id. |
| `model` | Provider-side model name (deployment name for Azure). |
| `apiKey` / `apiKeys` | Single key or pool. Merged; rotated on key-related errors. |
| `baseUrl`, `headers` | Endpoint override; required for `openai-compatible`. |
| `apiVersion` | Azure only. |
| `region`, `project` | Bedrock/Vertex region; GCP project for Vertex. |
| `maxRetries`, `timeoutMs` | Defaults 2 / 30000. |
| `streamIdleTimeoutMs` | Max silence between stream chunks. Default off. |
| `limit` | `{ rpm?, tpm? }`. |
| `budget` | `{ usd, windowMs? }`. Requires `pricing`. |
| `weight` | Traffic share under `strategy: "weighted"`. |

Engine options (second constructor argument): `store`, `fetchImpl`, `sleep`,
`rng`, `middleware`, `circuitBreaker`, `pricing`, `responseCache`,
`guardrails`, `onLog`. All optional; all injectable for testing.

Per-request options: `signal` (abort), `onAttempt`, `onFinish`, `onLog`.

## Extensibility

**Custom providers.** For endpoints outside the preset catalog, register an
adapter implementing `ProviderAdapter` (`complete`, `stream`, `raw`, optional
`embed`). Registered ids become valid `provider` values in configs.

```ts
import { registerAdapter } from "@ai-router/core";

registerAdapter("my-gateway", () => new MyGatewayAdapter());
// config: { id: "gw", provider: "my-gateway", model: "...", apiKey: "..." }
```

**Conformance kit.** Pure translation functions can be tested against the
same JSON fixtures the built-in adapters use — `runTranslationCases`,
`stableJson`, and related types are exported from `@ai-router/core`.

**Pluggable state.** `RateLimitStore` (four-method surface: `take`,
`record`, optional `used`, optional `snapshot`) and the response cache are
interfaces, not concrete services.

**Middleware & hooks.** `middleware.beforeRequest` /
`afterResponse` run around each attempt; `onLog` emits structured lifecycle
events (`call_start`, `cache_hit`, `route_skip`, `attempt_retry` with backoff
delays, `guardrail_block`); `onFinish` fires once per call with wall time,
TTFB (streams), attempts, usage, and cost. Callback errors are swallowed —
observability never breaks routing.

## Streaming

- Adapters perform the HTTP request eagerly, so HTTP errors throw before any
  chunk is consumed — this is what makes pre-first-token fallback possible.
- Chunks are a unified shape (`delta.content`, `delta.reasoning`,
  `delta.tool_calls`); usage lands on the final chunk when the provider
  reports it.
- Input guardrails apply to streams; output guards do not (scanning would
  require buffering, defeating the point).
- Helpers: `streamText(stream)` collects text; `collectStream(stream)`
  collects chunks.

```ts
import { streamText } from "@ai-router/core";
const text = await streamText(router.stream({ model: "fast", messages }));
```

## State and scaling

The default `MemoryStore` keeps rate-limit and budget windows in-process.
With multiple replicas each process counts independently — 3 pods ×
`rpm: 60` is effectively 180 rpm. Inject a shared store to fix it:

```ts
import { AIRouter } from "@ai-router/core";
import { RedisStore, ioredisClient } from "@ai-router/redis";
import Redis from "ioredis";

const router = new AIRouter(config, {
  store: new RedisStore({ client: ioredisClient(new Redis(process.env.REDIS_URL)) }),
});
```

[`@ai-router/redis`](packages/redis/) implements the same sliding-window
semantics atomically via Lua (ZSET-backed), works with ioredis, node-redis,
or any client exposing EVAL, has no hard dependency on either, and fails
open by default when Redis is unreachable.

What stays in-process regardless of store: circuit-breaker state and the
latency EMA. Multi-replica circuit breaking is a known limitation, listed below.

## Testing

```bash
npm install          # first
npm test             # vitest across all packages (~210 cases)
npm run conformance  # cross-SDK fixture tests
npm run typecheck    # depends on build
npm run build        # turbo build (core → redis → apps)
```

Run a single package or file:

```bash
npm test -w @ai-router/core
npx vitest run packages/core/tests/engine.test.ts
```

Test principles: mock-based unit tests (no snapshots), env vars read at call
time, and coverage requirements for each failure-recovery layer. Wire-format
correctness is additionally guarded by conformance fixtures — data-driven
JSON cases for request translation, response translation, chunk translation,
and SSE framing, shared across SDKs so implementations cannot drift.

Live smoke test against real APIs (manual, cheap models, ~16 tokens):

```bash
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=... \
  npx tsx scripts/smoke.ts
```

## Runtime characteristics

- **Zero runtime dependencies.** Core ships only compiled TypeScript;
  `fetch`, WebStreams, WebCrypto are assumed from the platform.
  Node ≥ 18, Bun, Deno, edge runtimes.
- **No hop.** Requests go from your process to the provider directly.
  Routing overhead is map lookups, a hash for cache keys, and integer math.
- **State footprint.** Per instance: circuit-breaker entries per route, key
  cursors, a latency EMA per route, and (default store) sliding-window logs
  sized by traffic within 60 s windows.
- **Token accounting.** tpm gating reads recorded usage post-hoc rather than
  reserving estimates pre-flight, so accounting matches provider reports.
  An `estimateTokens` heuristic is exported for callers building their own
  pre-flight gating.
- **Cost math.** Integer micro-dollar recording keeps budget arithmetic exact
  and safe for any store, including Redis Lua.

## Current limitations

Honest list; none are hidden behind marketing:

- **Pre-release software.** v0.1.0, unstable API, not yet on npm, no CI
  pipeline yet.
- **In-process intelligence.** Circuit-breaker state, least-latency EMA, and
  response-cache coordination are per engine instance. Only rate limiting and
  budgets have a shared-store path today.
- **Response cache is naive.** Exact-match FNV-1a hashing of the serialized
  request; fine for dedup, not adversarial-key safe. Bring a stronger hash in
  your backing store if that matters.
- **tpm gating is approximate under concurrency.** It checks recorded usage
  pre-flight and records post-hoc; bursts between check and record can
  overshoot within a window.
- **Unified-layer gaps** (use `router.raw()` or `providerOptions`):
  Gemini tool loops may need `thoughtSignature` round-tripping (not modeled);
  `json_schema` responses are dropped on Anthropic routes (no equivalent);
  logprobs and server-side tools are not modeled.
- **Modality scope.** Text chat, vision inputs, embeddings. Audio, image
  generation, and video are out of scope by design.
- **Guardrails on streams are input-only**, as described above.
- **Python SDK does not exist yet.**

## Roadmap

**Available**

- Adapters: OpenAI, Azure, Anthropic, Gemini, Bedrock (Converse + SigV4),
  Vertex (JWT auth), openai-compatible + 30+ presets
- Fallback chains, retries with backoff, key-pool rotation, circuit breaker
  with graduated cooldowns
- Sliding-window rate limits, USD budgets, tiered pricing, response cache
- Guardrails (input/output, block + rewrite), structured `onLog` events,
  call summaries with TTFB
- Committed streaming, embeddings, multimodal content, tool calling,
  structured output, reasoning surfaces, `raw()` escape hatch
- `@ai-router/redis` shared rate-limit store
- Conformance fixture suite (request/response/chunk/SSE)

**Planned**

- Python SDK validated against the same conformance fixtures
- CI pipeline and first npm release

**Exploring**

- Routing signals beyond config order and observed latency: provider health,
  cost-aware and quality-aware selection, adaptive routing informed by
  application-level feedback. Today's `least-latency` strategy (latency EMA)
  is the only adaptive signal implemented; nothing else should be assumed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Hard rules: zero runtime deps in
core, conformance fixtures are the cross-SDK contract (never edited
unilaterally), `model` is always a route id, ESM-only strict TypeScript.
Small diffs; run `npm test && npm run conformance && npm run build` before
pushing.

Repository layout:

```
packages/core/    @ai-router/core — the library
packages/redis/   @ai-router/redis — shared RateLimitStore
apps/example/     Next.js chat demo (env-driven fallback chain)
apps/docs/        Documentation site
scripts/smoke.ts  Live provider smoke test
```

## License

[MIT](LICENSE)
