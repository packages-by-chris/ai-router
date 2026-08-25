# ai-router

Provider-agnostic AI routing core. Users add their **own** provider keys; the
library handles fallback chains, key-pool rotation, rate limiting, retries,
and unified streaming. Pure client-side — no server, no key storage.

**Status: v0.1 — TypeScript reference implementation. Python SDK next, gated
on the shared conformance fixtures.**

## Locked design decisions

| Decision | Choice |
| --- | --- |
| Shape | Client-side library (no gateway service) |
| Languages v1 | TypeScript (npm) + Python (PyPI), native SDKs |
| Drift guard | Shared JSON conformance fixtures + config schema |
| API surface | Unified OpenAI-compatible shape + per-provider raw escape hatch (planned) |
| Rate limiting | Pluggable `RateLimitStore`; in-process default, Redis adapter opt-in |
| Config | Code-first + JSON-serializable `RouterConfig` |
| Providers v1 | OpenAI, Anthropic, Gemini, Azure, AWS Bedrock (Converse), Google Vertex, any `openai-compatible` base URL |
| Runtime deps | Zero. `fetch` + WebStreams + WebCrypto only (Node 18+, Bun, Deno, edge) |

## Semantics

**Fallback chain.** Config routes are ordered. A request for route id at
index `i` tries routes `i, i+1, …`. `model` in requests is a route id, never
a provider model name.

**Strategies.** `fallback` (default) tries strict order. `round-robin`
rotates the chain start each request. `weighted` picks the start
proportional to route `weight`, then falls back from there.
`least-latency` orders routes by a per-route latency EMA of observed
successes (unobserved routes are sampled first).

**Three recovery layers, in order:**

1. **Retry same route+key** — `rate_limit`, `server`, `network`, `timeout`.
   Exponential backoff (400 ms base, 8 s cap, 25% jitter); a server
   `Retry-After` raises the floor.
2. **Rotate key** on `rate_limit` / `auth` / `permission`. Round-robin cursor
   spreads successive requests across the pool.
3. **Next route** in the chain. Exhausted everywhere → `AllRoutesFailedError`
   carrying a full attempt trail.

**Circuit breaker.** Per route, after `threshold` consecutive failures the
route is skipped for `cooldownMs`. With `maxCooldownMs` set, each breach
doubles the cooldown up to the cap (graduated cooldowns); without it the
cooldown is fixed.

**Budgets.** A route may carry `budget: { usd, windowMs }`. Actual spend is
recorded post-hoc (micro-dollar integers) when `pricing` is configured;
once the rolling window's spend reaches the cap the route is skipped
pre-flight (`skipped_budget`) and traffic falls through. Stores without a
`used()` read-back fail open.

**Guardrails.** Input guards run once per call *before* routing and before
the response cache — a blocked input never reaches any provider. Output
guards run after `complete()` succeeds (post spend-recording). Guards may
block (`pass: false`) or rewrite (`replace`). Streams apply input guards
only; `raw()` bypasses everything by contract.

**Observability.** Three hooks: `onLog` (structured lifecycle events:
call_start, cache_hit, route_skip, attempt_retry with backoff delay,
guardrail_block), `onAttempt` (per routing decision), `onFinish` (settlement
summary with TTFB, usage, cost). Logger errors never break routing.

**Response cache.** Pass `responseCache` (`get`/`set`/`ttlMs`) to cache
exact-match `complete()` results by logical request hash. Bring your own
backing store.

**Streaming commit boundary.** `router.stream()` resolves only after the
first chunk has arrived — the serving route is final. Errors before the
first token are fallback-eligible; errors after commit surface to the caller.
A provider swap mid-stream is impossible and never attempted silently.

**Rate limiting.** `rpm` is enforced pre-flight (cost 1/request). `tpm` is
gated with a ~3.5-chars/token estimate pre-flight and corrected post-hoc
from provider usage reports (streaming included via
`stream_options.include_usage`). Both use a 60 s sliding window keyed per
route. In-process by default — inject a Redis-backed `RateLimitStore` for
multi-replica deployments.

**Guardrails.** Optional request/response validators that veto or rewrite
traffic. Input guards run once per call before routing (blocked calls never
reach a provider, never consume limits); output guards run after a successful
`complete()` result, post spend-recording. Streams apply input guards only;
`raw()` bypasses everything. Blocked calls throw `GuardrailBlockedError`
(phase, guardrail name, reason) and fire an `onLog` event.

**Observability (`onLog`).** Structured lifecycle events — call starts,
cache hits, route skips with reasons, retry backoffs, guardrail vetoes —
complementing the existing `onAttempt`/`onFinish` hooks. Callback errors are
swallowed; logging never breaks routing.

## Layout

```
packages/core/
  src/
    config/       schema + validating parser (aggregated error messages)
    http/         fetch w/ timeout, SSE parser (WebStreams)
    limiter/      RateLimitStore interface + sliding-window MemoryStore
    providers/    ProviderAdapter interface, adapters (openai, azure, anthropic,
                  gemini, bedrock, vertex), presets, registry
    guardrails.ts input/output validation hooks (block + transform)
    engine.ts     fallback / retry / key-rotation / stream-commit engine
    router.ts     AIRouter facade
  tests/          vitest suites (190+ tests)
  conformance/    JSON fixtures + runner — the cross-SDK drift guard
```

## Quickstart

```ts
import { AIRouter } from "@ai-router/core";

const router = new AIRouter({
  routes: [
    { id: "fast", provider: "openai", model: "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY, limit: { rpm: 60 } },
    { id: "backup", provider: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat",
      apiKey: process.env.DEEPSEEK_API_KEY },
  ],
});

const res = await router.complete({
  model: "fast", // falls back to "backup" if openai fails
  messages: [{ role: "user", content: "hi" }],
});

const stream = await router.stream({ model: "fast", messages: [...] });
for await (const chunk of stream) process.stdout.write(chunk.delta.content ?? "");
```

## Commands

```bash
npm install
npm test            # turbo run test — every package with tests
npm run conformance
npm run typecheck   # all packages, not just core
npm run build       # core + redis dist, nextjs example
```

Task graph lives in [`turbo.json`](turbo.json); builds are cached and
topologically ordered (`@ai-router/core` builds before dependents). Tests skip
the cache — they read env vars.

## Roadmap

1. ~~Anthropic adapter~~ done — typed SSE events, tool_use/tool_result blocks, system extraction, 529-overloaded retryable, stop_reason mapping
2. ~~Gemini adapter~~ done — generateContent + streamGenerateContent?alt=sse, functionCall/functionResponse parts, systemInstruction, generationConfig, finishReason mapping
3. ~~Redis `RateLimitStore` adapter~~ done — [`@ai-router/redis`](packages/redis/README.md), Lua-atomic sliding window, bring-your-own-client, fail-open default
4. ~~Raw escape hatch~~ done — `router.raw(routeId, { path?, body?, headers? })` → undecorated `Response`; rpm still gates, key cursor shared with unified calls
5. ~~Multimodal (images)~~ done — unified `content` accepts OpenAI-style parts (`text`, `image_url` with http(s) or data URIs); translated per provider
6. ~~Structured output + reasoning + caching surfaces~~ done — `response_format: json_schema` (OpenAI native, Gemini `responseJsonSchema`, dropped on Anthropic), `reasoning_effort` → OpenAI `reasoning_effort` / Anthropic thinking budget / Gemini `thinkingConfig`, reasoning text surfaced on messages and stream deltas, `Usage.cached_tokens` / `cache_write_tokens` / `reasoning_tokens`, Anthropic `cache_control` markers via message `providerOptions`, tiered pricing (`cache_read`, `cache_write`)
7. ~~Azure OpenAI adapter~~ done — deployment URLs, `api-key` auth, required `apiVersion`; reuses the OpenAI translation wholesale
8. ~~Routing strategies~~ done — `weighted` (weight-proportional start) and `least-latency` (EMA ordering, exploration-first for unobserved routes)
9. ~~Budgets + graduated cooldowns + response cache + call summaries~~ done — route `budget.usd` rolling-window enforcement, circuit-breaker cooldown doubling up to `maxCooldownMs`, pluggable exact-match response cache, `onFinish` summary events with TTFB and total latency
10. ~~Bedrock adapter~~ done — Converse API across all Bedrock models, hand-rolled SigV4 over WebCrypto, binary event-stream parser, toolUse/toolResult blocks, reasoningContent
11. ~~Vertex AI adapter~~ done — regional Vertex endpoints, service-account JWT exchange (RS256 over WebCrypto) with token caching or bearer passthrough, shared Gemini translation, `:predict` embeddings
12. ~~Guardrails~~ done — input/output validators with block + transform verdicts; input runs pre-routing/pre-cache, output post-spend on complete()
13. ~~onLog observability~~ done — structured lifecycle events (call_start, cache_hit, route_skip, attempt_retry with backoff delays, guardrail_block); engine-level + per-call hooks
14. ~~Conformance: response + SSE fixtures~~ done — response cases for all adapters (incl. Bedrock), openai chunk-translation cases, `sse_parse` framing cases; runner supports async handlers
15. ~~Provider presets expansion~~ done — 30+ OpenAI-compatible vendors
16. Python SDK against the same conformance fixtures
17. CI/CD pipeline + npm publish

### Provider presets & custom adapters

`provider` accepts built-in adapters (`openai`, `openai-compatible`,
`azure`, `anthropic`, `gemini`, `bedrock`, `vertex`) plus a **preset
catalog** of 30+ vendors that serve OpenAI-compatible APIs — groq, deepseek,
mistral, openrouter, together, fireworks, perplexity, xai, cerebras,
sambanova, cohere, deepinfra, nvidia, github-models, hyperbolic, novita,
nebius, lambda, moonshot, zhipu, yi, stepfun, upstage, ai21, huggingface,
scaleway, ovhcloud, hunyuan, friendliai, kluster, and keyless local runtimes
(ollama, lmstudio, vllm):

```ts
{ id: "fast", provider: "groq", model: "llama-3.3-70b-versatile",
  apiKey: "${GROQ_API_KEY}" }               // baseUrl/auth resolved for you
{ id: "local", provider: "ollama", model: "llama3.2" }  // no key needed

// Cloud enterprise providers:
{ id: "aws", provider: "bedrock", region: "us-east-1",
  model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
  apiKey: "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" }
{ id: "gcp", provider: "vertex", region: "us-central1", project: "my-proj",
  model: "gemini-2.0-flash", apiKey: "${GCP_SA_KEY_JSON}" }
```

Explicit `baseUrl`/`headers` on the route always win over preset values.

For anything outside the catalog, register a third-party adapter:

```ts
import { registerAdapter, knownProviderIds } from "@ai-router/core";
registerAdapter("my-gateway", () => new MyGatewayAdapter());
// now valid in configs: { provider: "my-gateway", ... }
```

External adapters can run the conformance fixtures against their own
translation functions via the exported kit
(`runTranslationCases`, `stableJson`, types from `@ai-router/core`).

### providerOptions escape hatch

Per-request extras ride along with translation/retries/fallback (unlike
`router.raw()`). Namespaces merge into the wire body; later keys win:

```ts
router.complete({
  model: "smart",
  messages,
  providerOptions: {
    openai: { parallel_tool_calls: false },
    anthropic: { metadata: { user_id: "u1" } },
    gemini: { safetySettings: [] },
    azure: { seed: 42 },
  },
});
```

Prompt-cache breakpoints are message-level:
`{ role: "system", content: "...", providerOptions: { anthropic: { cache_control: true } } }`.

## Example app

[`apps/example`](apps/example/README.md) — Next.js chat UI
streaming through the router with an env-driven fallback chain (first
provider key set = primary, rest = fallbacks). Shows the singleton-router
pattern for frameworks with hot reload.

### Docs site

[`apps/docs`](apps/docs) — Next.js documentation site: sidebar navigation,
syntax-highlighted pages covering the full API, and a landing page, styled
with the same console theme as [`apps/example`](apps/example/README.md).
Content lives in `apps/docs/content/*.md`. `npm run dev` starts both apps;
docs alone: `npm run dev -w @ai-router/docs`.

## Live smoke test

Mocks prove plumbing; real APIs prove wire format. Before trusting a release:

```bash
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=... \
  npx tsx scripts/smoke.ts
```

One tiny completion + one tiny stream per provider with a key set (haiku /
flash / mini class, ~16 max tokens). Non-zero exit on any failure.

### Known unified-layer limits (use `router.raw` for these)

- Gemini 3 tool loops may need `thoughtSignature` round-tripping — not
  modeled; use raw for Gemini 3 function calling until it is
- Gemini image URLs get mimeType guessed from the file extension
- `response_format: json_schema` on Anthropic routes is dropped (no
  equivalent); logprobs, server tools: not modeled — use raw or
  `providerOptions`
- Audio/image-generation/video surfaces are out of scope by design

### Multi-replica rate limiting

In-process limiting undercounts by replica count (3 pods × 60 rpm config =
180 rpm real). Shared state fixes it:

```ts
import { RedisStore, ioredisClient } from "@ai-router/redis";

new AIRouter(config, { store: new RedisStore({ client: ioredisClient(redis) }) });
```

### Anthropic translation notes

- `system` messages → top-level `system` (joined `\n\n`); consecutive
  same-role messages merged into single turns
- `max_tokens` required by Anthropic — defaults to 4096 when omitted
- tool loop: assistant `tool_calls` → `tool_use` blocks (arguments parsed);
  `role: "tool"` messages → user-turn `tool_result` blocks; response
  `tool_use` blocks → unified `tool_calls` (arguments re-serialized)
- `stop` → `stop_sequences`; `response_format` has no equivalent (dropped)
- stop_reason map: `end_turn|stop_sequence|pause_turn`→`stop`,
  `max_tokens`→`length`, `tool_use`→`tool_calls`, `refusal`→`content_filter`
- HTTP 529 (overloaded) classifies as retryable `server`; mid-stream
  `error` events surface as ProviderErrors after the commit boundary

### Gemini translation notes

- roles `user`/`model`; system → top-level `systemInstruction`
- sampling under `generationConfig`: `maxOutputTokens`, `stopSequences`,
  `responseMimeType` (from `response_format: json_object`)
- tools nest under `tools[0].functionDeclarations`; `tool_choice` maps to
  `toolConfig.functionCallingConfig` — `AUTO`/`ANY`/`NONE`, named forcing
  via `allowedFunctionNames`
- tool loop: assistant `tool_calls` → `functionCall` parts; `role:"tool"`
  → user-turn `functionResponse` parts (`response` must be a JSON object;
  function NAME resolved from the earlier tool_call id, since Gemini
  identifies responses by name)
- finishReason map: `STOP`→`stop`, `MAX_TOKENS`→`length`,
  `SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT`→`content_filter`
- blocked prompts arrive as HTTP 200 with `promptFeedback.blockReason` and
  no candidates → unified `content_filter`
- streaming via `models/{model}:streamGenerateContent?alt=sse`; usage
  accumulates from `usageMetadata` across chunks, emitted on the final one
