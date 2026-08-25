# ai-router

**An embeddable, provider-agnostic AI routing engine for TypeScript.**

ai-router provides the routing and reliability capabilities of an AI gateway
without requiring you to deploy one. It runs inside your application process,
talks to providers directly over their native APIs, and handles the
operational work — fallback chains, retries, key-pool rotation, rate limits,
budgets, circuit breaking, unified streaming. Your API keys never leave your
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

**Status:** v0.2.0, pre-release. The TypeScript core is feature-complete for
its scope and covered by mock-based tests plus shared conformance fixtures.
A Python SDK built against the same fixtures is planned but does not exist
yet. The package is not yet published to npm.

## What you get

- **Multi-provider routing** — one unified request shape, translated per provider in both directions.
- **Ordered fallback chains** — a request tries route *i*, then *i+1*, … until one succeeds.
- **Capability-aware routing** — declare what each model supports (`tools`, `vision`, `structuredOutput`, `contextWindow`, …); incompatible candidates are eliminated before any network I/O.
- **Cost-aware routing** — `cheapest` and `balanced` strategies from declared pricing, plus per-call `maxCostUsd` constraints.
- **Latency-aware routing** — `least-latency` EMA plus observed p50/p95/p99 and stream TTF percentiles feeding policies and `maxLatencyMs` constraints.
- **Quality-aware routing (adaptive foundation)** — applications record outcomes via `recordOutcome()`; `quality-first` routes by measured task quality.
- **Retries with backoff** — exponential, honoring provider `Retry-After`, clamped to the caller's `deadlineMs`.
- **API-key rotation** — key pools per route, rotated on key-related errors; rate-limited keys cool down instead of burning attempts.
- **Rate limiting** — per-route rpm (pre-flight) and tpm (post-hoc) sliding windows.
- **Spend budgets** — rolling USD caps per route, priced from token usage.
- **Circuit breaking** — skip failing routes, with graduated cooldowns.
- **Unified streaming** — committed streams, SSE parsed for every wire format; mid-stream aborts tear down the upstream connection.
- **Tool calling & multimodal input** — translated across providers, including streams.
- **Guardrails** — input/output validators that block or rewrite traffic.
- **Observability** — structured lifecycle events, per-attempt hooks, end-of-call summaries with TTFB, usage, and cost, plus a health snapshot (percentiles, error tallies, key cooldowns).
- **Dry-run routing** — `router.explain()` returns the full decision: candidates, rejections with reasons, estimated cost — without executing anything.
- **Raw escape hatch** — send anything the unified layer doesn't model straight to the provider.

Under the hood: 6 protocol adapters, 30+ provider presets, zero runtime
dependencies (`fetch`, WebStreams, and WebCrypto only), Node 18+, Bun, Deno,
and edge runtimes.

## Routes, not model names

Your application requests a **logical route**:

```ts
model: "fast"     // not "gpt-4o-mini"
model: "smart"    // not "claude-sonnet-4-..."
```

ai-router decides which provider and model actually serve that route, walking
the configured chain until one works. This keeps concerns separated:

- Provider changes don't require application changes — edit config, not code.
- Fallback stays outside business logic — no `try { openai } catch { claude }`.
- Routing policy is centralized in one declarative place.
- Provider failures are handled below the application layer, transparently.

The `model` field is always a route id. It is never a raw provider model name.

## Quick start

> Not yet on npm (see [Status](#status)); install from a git ref or local
> path until the first release.

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
(or an explicit env map). Plain `apiKey` values work too.

Streaming uses the same routes and recovery machinery:

```ts
const stream = await router.stream({
  model: "fast",
  messages: [{ role: "user", content: "hi" }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.delta.content ?? "");
}
```

## A library, not a gateway

Hosted gateways solve reliability by inserting a service between you and the
provider. That adds a network hop, an operator, a bill, and a third party
terminating your credentials. Many applications don't need any of that — they
need the *logic* of a gateway embedded in the app.

| | Hosted gateway | Proxy server (LiteLLM) | ai-router |
| --- | --- | --- | --- |
| Runs | Vendor's cloud | A service you operate | In your process |
| Extra network hop | Yes | Yes | None |
| Provider keys | Often theirs / proxied | Yours, stored server-side | Yours, never leave the app |
| Failure domain | Vendor + your app | Proxy + your app | Your app only |
| Language | Any (HTTP) | Python-centric | TypeScript-native |
| Shared state across replicas | Built in | Built in | Optional (`@ai-router/redis`) |

Choose ai-router when routing behavior should live in your TypeScript
codebase rather than in another piece of infrastructure to run. Choose a
hosted gateway when many heterogeneous applications need one shared control
plane — the two approaches also compose: ai-router can route to a gateway as
just another OpenAI-compatible provider.

## Routing strategies

Configured at the top level with `strategy`. Strategies reorder the fallback
chain start; tail routes still serve if the chosen start fails.

| Strategy | Selection |
| --- | --- |
| `"fallback"` *(default)* | Strict config order — primary until it fails. |
| `"round-robin"` | Each request rotates the chain start cyclically. |
| `"weighted"` | Start picked proportionally to route `weight`, then falls back in order. |
| `"least-latency"` | Fastest-first by per-route latency EMA of observed successes; unobserved routes are sampled first. |
| `"cheapest"` | Priced routes by estimated per-request USD ascending (input estimate + `max_tokens` at declared prices); unpriced routes follow in config order. Requires `pricing`. |
| `"balanced"` | Score = 0.5·cost + 0.3·speed + 0.2·reliability, rank-normalized across candidates; unpriced/unobserved signals are neutral. |
| `"quality-first"` | Orders by application-recorded outcome quality (`recordOutcome`, keyed by `routing.task`); degrades to balanced scoring without data. |

Latency, health, and outcome tracking is in-process (per engine instance).
See [Current limitations](#current-limitations).

### Capability-aware routing

Declare what each route supports; the router eliminates incompatible
candidates before execution:

```ts
const router = new AIRouter({
  strategy: "cheapest",
  pricing: { fast: { input: 0.15, output: 0.6 }, smart: { input: 3, output: 15 } },
  routes: [
    { id: "fast", provider: "groq", model: "llama-3.3-70b",
      apiKey: "${GROQ_API_KEY}",
      capabilities: { tools: true, contextWindow: 128_000 } },
    { id: "smart", provider: "anthropic", model: "claude-sonnet-4",
      apiKey: "${ANTHROPIC_API_KEY}",
      capabilities: { tools: true, vision: true, structuredOutput: true, contextWindow: 200_000 } },
  ],
});

// A tools+vision request skips "fast" (no vision) without contacting it:
await router.complete({
  model: "fast",
  messages: [{ role: "user", content: [
    { type: "text", text: "what's in this image?" },
    { type: "image_url", image_url: { url: "https://…" } },
  ]}],
});
```

Two elimination paths:

- **Request inference** (metadata-driven): requests carrying tools need a
  tool-capable route; image parts → `vision`; `json_object` → `json`;
  `json_schema` → `structuredOutput`; `reasoning_effort` → `reasoning`;
  oversized inputs vs `contextWindow`; `stream()`/`embed()` → their flags.
  Only routes that DECLARE capabilities can be excluded — undeclared routes
  stay eligible so existing configs never change behavior.
- **Explicit requirements** (hard constraints): `routing.require` rejects any
  route not declaring the capability true, including undeclared ones.

```ts
await router.complete(req, {
  routing: {
    require: { tools: true },          // hard constraint
    maxCostUsd: 0.01,                  // estimated-cost ceiling
    maxLatencyMs: 1_500,               // observed p50 ceiling
    task: "support-ticket",            // bucket for quality-first routing
    filter: (route) => !route.id.startsWith("eu-"), // custom, secret-free view
  },
});
```

### Dry-run routing & explanations

```ts
const decision = await router.explain({
  model: "smart",
  messages,
});
// {
//   model: "smart", strategy: "cheapest",
//   candidates: [
//     { routeId: "smart", status: "selected",
//       reasons: ["declared capabilities satisfy the request",
//                 "estimated cost $0.000012"], ... },
//     { routeId: "fast", status: "backup", ... },
//   ],
// }
```

Executes nothing, consumes no quota, and never contains credentials.

### Recording outcomes (adaptive foundation)

Applications know quality best — faithfulness for summarization, task
completion for agents. Record what happened and `quality-first` routing uses
it:

```ts
const res = await router.complete(req, { routing: { task: "summarize" } });
router.recordOutcome({
  routeId: res.provider === "groq" ? "fast" : "smart", // or track from onFinish
  task: "summarize",
  success: true,
  quality: 0.92,          // your eval, your scale — never invented by the router
  latencyMs: summary.totalMs,
  costUsd: res.cost_usd,
});
```

Deterministic EMA aggregation per (task, route); no opaque ML. With no data,
`quality-first` gracefully falls back to balanced cost/speed ordering.

### Call deadlines

```ts
await router.complete(req, { deadlineMs: 5_000 }); // whole-call wall clock
```

Backoff sleeps truncate at the deadline, per-attempt HTTP timeouts clamp to
the remaining budget, and breach throws `DeadlineExceededError` — the
caller's intended deadline is never overshot across retries and fallbacks.
For streams it governs acquiring the committed stream, not consuming it.

### Health observability

```ts
const stats = await router.stats();
stats.health; // per route: successes/failures, error tallies by kind,
              // p50/p95/p99 latency, TTFT percentiles, per-key cooldowns
stats.outcomes; // recorded outcome EMAs per (task, route)
```

Keys that answered `429` with `Retry-After` cool down automatically and are
skipped on later calls instead of burning attempts (`key_skip` log events).

## Reliability model

Three recovery layers run in order before a request fails:

1. **Retry same route + key** — retryable error kinds (`rate_limit`,
   `server`, `network`, `timeout`) get exponential backoff (400 ms base,
   8 s cap, 25% jitter), honoring provider `Retry-After` as a floor.
   Per-route `maxRetries` (default 2) and `timeoutMs` (default 30 s).
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

Error classification drives all of this. Every failure is a typed
`ProviderError` with a `kind` from a closed taxonomy: `rate_limit`, `auth`,
`permission`, `not_found`, `invalid_request`, `server`, `network`,
`timeout`, `unknown`.

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

### Adapters vs presets

Most vendors serve OpenAI-compatible APIs; those are data, not code. A preset
resolves adapter + base URL + auth style from the provider id alone, so a new
provider costs one table entry instead of an adapter. Native adapters are
reserved for protocol outliers. 30+ presets ship built in — groq, deepseek,
mistral, together, fireworks, perplexity, xai, cerebras, openrouter, cohere,
sambanova, nvidia, github-models, and more — plus keyless local runtimes
(`ollama`, `lmstudio`, `vllm`):

```ts
{ id: "fast", provider: "groq", model: "llama-3.3-70b-versatile",
  apiKey: "${GROQ_API_KEY}" }
{ id: "local", provider: "ollama", model: "llama3.2" }  // no key needed
```

Explicit `baseUrl` / `headers` on a route always win over preset values.

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

Anything still outside the unified layer goes through
`router.raw(routeId, { path?, body?, headers?, method?, signal? })`, which
returns the undecorated provider `Response`. Raw calls get rpm gating and
share the key cursor, but no retries or fallback.

## Configuration

Configs are JSON-serializable objects validated by `parseConfig`, which
collects all violations into one `ConfigError` with JSON-path locations.
Pass raw input (e.g. a loaded JSON file) to `new AIRouter(...)` and it is
validated on construction.

```ts
interface RouterConfig {
  routes: ModelRoute[];   // ordered fallback chain
  strategy?: RoutingStrategy; // fallback | round-robin | weighted | least-latency | cheapest | balanced | quality-first
}
```

Route fields:

| Field | Meaning |
| --- | --- |
| `id` | Logical name used as `model` in requests. Unique. |
| `provider` | Built-in adapter, preset id, or registered custom id. |
| `model` | Provider-side model name (deployment name for Azure). |
| `apiKey` / `apiKeys` | Single key or pool. Merged; rotated on key-related errors. |
| `capabilities` | Declared profile (`tools`, `vision`, `json`, `structuredOutput`, `streaming`, `reasoning`, `embeddings`, `multimodal`, `longContext`, `audio`, `contextWindow`). Enables pre-flight elimination. Omitted = route always eligible. |
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

Per-request options: `signal` (abort), `deadlineMs` (wall-clock budget),
`routing` (`require`, `task`, `maxCostUsd`, `maxLatencyMs`, `filter`),
`onAttempt`, `onFinish`, `onLog`.

Facade extras: `router.explain(req)` (dry-run), `router.recordOutcome(...)`
(quality feedback), `router.stats()` (health + outcomes snapshot).

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

**Middleware & hooks.** `middleware.beforeRequest` / `afterResponse` run
around each attempt; `onLog` emits structured lifecycle events (`call_start`,
`cache_hit`, `route_skip`, `attempt_retry` with backoff delays,
`guardrail_block`); `onFinish` fires once per call with wall time, TTFB
(streams), attempts, usage, and cost. Callback errors are swallowed —
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
npm test             # vitest across all packages (~280 cases)
npm run conformance  # cross-SDK fixture tests
npm run typecheck    # depends on build
npm run build        # turbo build (core → redis → apps)
npm run bench        # routing-overhead microbenchmark (offline, mock fetch)
```

Run a single package or file:

```bash
npm test -w @ai-router/core
npx vitest run packages/core/tests/engine.test.ts
```

Test principles: mock-based unit tests (no snapshots), env vars read at call
time, coverage requirements for each failure-recovery layer, and a
deterministic provider simulator (`tests/simulator.ts`) driving failure
scenarios — timeouts, rate limits, auth failures, mid-stream deaths, flaky
recovery. Security tests assert credentials never appear on any error or
telemetry surface. Wire-format correctness is additionally guarded by
conformance fixtures — data-driven JSON cases for request translation,
response translation, chunk translation, and SSE framing, shared across SDKs
so implementations cannot drift.

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
  Routing overhead is map lookups, ring-buffer math, and a hash for cache
  keys — microbenchmark with a mock fetch shows ~2 µs per request over a
  direct adapter call (`npm run bench`; environment-dependent, re-measure
  before quoting).
- **State footprint.** Per instance: circuit-breaker entries per route, key
  cursors, latency EMA + fixed-size health rings (128 samples) per route,
  outcome EMAs, and (default store) sliding-window logs sized by traffic
  within 60 s windows.
- **Token accounting.** tpm gating reads recorded usage post-hoc rather than
  reserving estimates pre-flight, so accounting matches provider reports.
  An `estimateTokens` heuristic is exported for callers building their own
  pre-flight gating.
- **Cost math.** Integer micro-dollar recording keeps budget arithmetic exact
  and safe for any store, including Redis Lua.

## Current limitations

Honest list; none are hidden behind marketing:

- **Pre-release software.** v0.2.0, unstable API, not yet on npm, no CI
  pipeline yet.
- **In-process intelligence.** Circuit-breaker state, latency/health tracking,
  key cooldowns, outcome memory, and response-cache coordination are per
  engine instance. Only rate limiting and budgets have a shared-store path today.
- **Cost estimates are estimates.** `cheapest`/`balanced` and `maxCostUsd` use
  a token heuristic plus declared pricing (output assumed ≈ input when
  `max_tokens` is unset); actual spend accounting from provider usage remains
  the source of truth for budgets.
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

Today a request flows: **capability/constraint filtering → policy ordering →
provider → retry/fallback → outcome feedback**, with health, cost, and
application-recorded quality as adaptive signals.

**Available**

- Adapters: OpenAI, Azure, Anthropic, Gemini, Bedrock (Converse + SigV4),
  Vertex (JWT auth), openai-compatible + 30+ presets
- Fallback chains, retries with backoff, key-pool rotation, circuit breaker
  with graduated cooldowns, call deadlines
- Sliding-window rate limits, USD budgets, tiered pricing, response cache
- Capability-aware routing (`capabilities` + `routing.require` + inference)
- Cost/latency/quality policies: `cheapest`, `balanced`, `quality-first`,
  `maxCostUsd`, `maxLatencyMs`, custom filters
- Health tracking (percentiles, error tallies, key cooldowns) in `stats()`
- Dry-run routing via `explain()`; `recordOutcome()` adaptive foundation
- Guardrails (input/output, block + rewrite), structured `onLog` events,
  call summaries with TTFB
- Committed streaming, embeddings, multimodal content, tool calling,
  structured output, reasoning surfaces, `raw()` escape hatch
- `@ai-router/redis` shared rate-limit store
- Conformance fixture suite (request/response/chunk/SSE)

**Planned**

- Python SDK validated against the same conformance fixtures (validator port:
  new strategies + `capabilities` field — see CHANGELOG)
- CI pipeline and first npm release

**Exploring**

- Cross-replica health/circuit sharing alongside the Redis store
- Throughput (tokens/sec) as a first-class routing signal
- richer A/B/canary primitives on top of weighted routing

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
