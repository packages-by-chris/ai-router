# Architecture

This document explains how ai-router works internally: the execution flow,
the failure-recovery layers, and where each concern lives. For usage, see the
[README](README.md) and `apps/docs/content/`.

## Positioning

ai-router is an **embeddable TypeScript routing engine**, not a gateway
service. It runs inside your process (Node 18+, Bun, Deno, edge runtimes),
speaks to providers directly with your keys, and adds:

- fallback chains with ordered (or scored) candidate selection
- retry / key-rotation / circuit-breaking
- rate-limit + USD-budget gating through a pluggable store
- capability-aware, cost-aware, latency-aware, and quality-aware routing
- a streaming commit boundary that makes mid-stream provider swaps impossible

Zero runtime dependencies: `fetch` + WebStreams + WebCrypto only.

```
Request
  ↓
normalize (guardrails → response cache)
  ↓
candidate generation        resolveChain(): slice from requested route id,
  ↓                         reordered by strategy
capability filtering        declared profiles vs explicit require +
  ↓                         request-inferred needs (+ custom filter,
  ↓                         maxCostUsd/maxLatencyMs constraints)
health gating               circuit breaker state, read-only budget/tpm checks
  ↓                         (rpm consumed here in real calls)
execution                   adapter.complete/stream/embed with one key
  ↓
retry                       backoff w/ jitter, Retry-After floor, deadline clamp
  ↓                         key rotation on rate_limit/auth/permission
fallback                    next candidate; repeats until one commits
  ↓
telemetry                   onAttempt / onLog / onFinish, health recording
  ↓
feedback                    recordOutcome() → quality-first ordering
```

The first four stages happen per candidate BEFORE any network I/O. Once an
attempt reaches an adapter, only the engine's failure-recovery layers apply.

## Module map (`packages/core/src/`)

| Module | Responsibility |
| --- | --- |
| `config/schema.ts` | JSON-serializable config types (cross-SDK contract) |
| `config/parse.ts` | validating parser; aggregates ALL violations; `${ENV}` interpolation |
| `engine.ts` | orchestration: candidate loop, retries, key rotation, circuit breaker, deadlines, budgets, cache, guardrails |
| `router.ts` | `AIRouter` facade — stable public surface over the engine |
| `routing/capabilities.ts` | capability metadata + elimination rules |
| `routing/health.ts` | per-route/per-key health: latency+TTFT ring buffers, percentiles, cooldowns |
| `routing/order.ts` | cost estimation + scoring for cheapest/balanced strategies |
| `routing/outcomes.ts` | application-recorded quality EMAs (task, route) |
| `providers/types.ts` | `ProviderAdapter` interface — the wire-protocol boundary |
| `providers/*.ts` | adapters (openai, azure, anthropic, gemini, bedrock, vertex) + presets |
| `limiter/*` | `RateLimitStore` interface + in-process sliding-window MemoryStore |
| `http/request.ts` | fetch with timeout + caller-abort relay; Retry-After parsing |
| `http/sse.ts` | minimal SSE parser over WebStreams |
| `errors.ts` | error taxonomy; classification drives recovery decisions |
| `guardrails.ts` | input/output validators (block or rewrite) |

Provider adapters are deliberately thin: they translate one HTTP round trip
in each direction and never make policy decisions. All routing policy lives in
the engine + `routing/` modules.

## Failure recovery layers

For every candidate, failures are classified into kinds (`rate_limit`,
`auth`, `permission`, `not_found`, `invalid_request`, `server`, `network`,
`timeout`) which select the recovery layer:

1. **Retry same route+key** for `rate_limit` / `server` / `network` /
   `timeout`. Exponential backoff (400 ms base, 8 s cap, 25 % jitter); a
   provider `Retry-After` raises the floor. Backoff sleeps are truncated at
   the call's `deadlineMs`.
2. **Rotate key** on same route for `rate_limit` / `auth` / `permission`.
   Keys that answered with a `Retry-After` go on cooldown (capped at 5 min)
   so later calls skip them without burning attempts.
3. **Next candidate** in the ordered chain. Exhausted everywhere →
   `AllRoutesFailedError` carrying the full attempt trail.

Caller cancellation short-circuits everything: once the caller's signal
fires, the original abort error propagates — no retry, no rotation, no
fallback. The signal is relayed into each attempt through a per-attempt
`AbortController` that also carries the `deadlineMs` timer, so aborting a
stream mid-body cancels the upstream HTTP connection (see below).

## Streaming commit boundary

`router.stream()` resolves only after the first chunk has arrived. Before
that point, all recovery layers apply (a stalled stream start falls back to
the next route via `streamIdleTimeoutMs`). After commit the serving route is
final: errors surface to the caller and the engine NEVER silently switches
providers or concatenates unrelated streams.

Mechanics worth knowing:

- Each attempt gets a linked `AbortController`; its signal is what the
  adapter passes to `fetch`. `fetchWithTimeout({ streaming: true })` keeps
  the caller-abort relay attached after headers arrive so mid-stream aborts
  tear down the connection.
- A disposing iterator wrapper releases the attempt's timers/listeners when
  the stream ends — normally, on error, or when the caller breaks early.
- An immediately-empty stream yields one synthetic empty chunk as the commit
  sentinel (documented behavior).

## Routing policies

Strategies decide candidate ORDER; elimination happens separately per
candidate. All strategies keep fallback semantics after the chosen start:
if the preferred route fails, the next candidate serves.

- `fallback` (default), `round-robin`, `weighted`, `least-latency` — see README.
- `cheapest` — priced routes by estimated per-request USD ascending;
  unpriced routes follow in config order.
- `balanced` — `0.5·cost + 0.3·speed + 0.2·reliability`, rank-normalized
  across the candidate slice; missing signals are neutral 0.5.
- `quality-first` — orders by application-recorded outcome quality
  (`recordOutcome`, keyed by optional `routing.task`); degrades to balanced
  scoring without data. This is the deterministic foundation for adaptive
  routing: decision → execution → outcome → recorded feedback → improved
  future ordering. No opaque ML.

Per-call constraints (`CallOptions.routing`) eliminate candidates before
execution: `require` (hard capability constraints), `maxCostUsd`
(estimated), `maxLatencyMs` (observed p50), and a custom `filter` receiving
a secret-free `RouteView`.

`router.explain(req)` replays the same gates WITHOUT executing or consuming
quota and returns candidates with reasons, estimated cost, observed latency
— the dry-run surface.

## State and multi-replica reality

Everything the engine learns at runtime (latency EMAs, health percentiles,
key cooldowns, circuit breakers, outcome memory) is **in-process**. Only the
rate-limit/budget counters go through the pluggable store; inject
`@ai-router/redis` for shared state across replicas. In-process signals are
per-instance by design — correct for single-process serverless/edge
deployments, advisory for multi-replica ones.

## Conformance

`packages/core/conformance/cases/*.json` are the cross-SDK drift guard:
request AND response translation asserted against fixtures shared with the
Python SDK. Never edit them unilaterally (see CONTRIBUTING.md).
