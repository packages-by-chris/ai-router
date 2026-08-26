# Changelog

## 0.3.0

Routing intelligence release: persistent learned state, staleness-aware
statistics, statistical rigor, exploration, quality evaluators, and an
offline replay harness. Backwards compatible: every new option is optional,
legacy `stats()`/health snapshot fields are preserved, and default behavior
changes only where the old behavior was a bug (see Fixed).

### Added — persistent learned state (P0)

- `EngineOptions.stateStore` (`RouterStateStore`: get/set JSON): persists
  health stats, outcome memory, and circuit-breaker state under one snapshot
  key. Loads at startup (`await engine.ready()` for determinism), flushes
  debounced after mutations; corrupt snapshots start fresh, store failures
  never break routing. Last-writer-wins semantics — telemetry-grade sharing,
  not linearizable counters (use `RateLimitStore` for limits/budgets).
- `@ai-router/redis` ships `RedisStateStore` (same bring-your-own-client
  EVAL pattern as `RedisStore`) implementing `RouterStateStore`.

### Added — staleness controls (P0)

- `EngineOptions.decay.halfLifeMs` (default 30 min): success/failure evidence
  and outcome EMAs decay toward neutral during silence — stale verdicts can
  no longer outrank fresh ones forever. `0` disables.
- `EngineOptions.decay.sampleTtlMs` (default 10 min): latency samples older
  than the TTL stop counting toward percentiles and least-latency ordering;
  fully-stale routes degrade to "unobserved" and get re-sampled. `0` keeps
  everything.

### Changed — latency statistics rebuilt (P1)

- Latency tracking is now **per operation** (`complete` total vs `stream`
  TTFB) with timestamped ring buffers; the old single per-route EMA that
  conflated both is gone. `least-latency` orders by fresh p50 of the op
  being routed; `stats().latencies` keeps a blended view for compatibility.
- **Fixed:** `balanced`'s speed term previously ranked slowest-best (latent
  bug, unobservable while tests used equal latencies). Lowest latency now
  scores best.
- **Changed:** failed attempts contribute latency evidence ONLY for
  `timeout`/`network` kinds. A fast 500 no longer has any path to making a
  broken route look fast.

### Added — statistical rigor (P1)

- Reliability term uses a Wilson LOWER bound over decayed success/failure
  counts: a lucky 3/3 streak cannot outrank a proven 12/13.
- Thinly-sampled latencies shrink toward the best well-sampled candidate
  (`shrinkLatencies`, k=3); when nothing is well-sampled, raw values pass.
- Timeout share penalizes the reliability component (decayed timeout-weight
  / failure-weight).
- `wilsonLowerBound()` exported from `@ai-router/core`.

### Added — exploration (P1, opt-in)

- `EngineOptions.explore: { epsilon?, interval? }`: periodically promote a
  non-primary candidate so losers keep getting sampled and rankings recover.
  Default OFF — routing stays deterministic unless enabled. Every probe
  emits an `explore` log event naming promoted/replaced routes. `explain()`
  never explores.

### Added — scoring transparency + weights (P2)

- `explain()` populates the previously-declared-but-dead `score` field for
  `balanced`/`quality-first`, adds `scoreBreakdown`
  (`{cost, speed, reliability, total}`) on every scored candidate plus a
  human-readable `score ...` reason on the selection.
- Config `weights: { cost?, speed?, reliability? }` (validated by
  `parseConfig`, normalized to sum 1; defaults 0.5/0.3/0.2) tunes the
  balanced score. NOTE for the future Python validator: new top-level
  config field.

### Added — actual-cost feedback (P2)

- When `pricing` is configured, observed spend is compared against the
  pre-flight estimate per call; the route's estimate is thereafter corrected
  by its decayed actual/estimate ratio EMA (`stats().health[].costRatio`).
  Systematically underestimated routes lose cost-based ranking they don't
  deserve.

### Added — evaluators & workload inference (P3, opt-in)

- `EngineOptions.evaluators: QualityEvaluator[]`: pluggable quality scorers
  run after successful `complete()` calls; averaged scores feed outcome
  memory automatically (throw = abstain). 
- `EngineOptions.autoTask`: infer the quality-first task bucket from request
  shape (`tool-use`, `vision`, `structured`, `reasoning`, `long-context`,
  `chat`) when `routing.task` is unset. `inferTask()` exported.

### Added — offline replay harness (P3)

- `replayStrategy(config, strategy, events)` replays recorded requests +
  outcomes through the exact pure ordering code the live engine uses —
  answer "what would strategy X have picked?" without touching providers.

### Fixed

- `balanced` speed direction (above), dead `explain().score` field, and the
  complete/stream latency conflation — all three were audit findings.

## 0.2.0

New routing capabilities, deadline enforcement, and two streaming-correctness
fixes. Backwards compatible for existing configs and call sites: every new
config field and option is optional, and routes without declared
capabilities are never filtered.

### Added — capability-aware routing

- `capabilities` on routes (`ModelRoute.capabilities`): declared profile with
  `streaming`, `tools`, `vision`, `json`, `structuredOutput`, `reasoning`,
  `audio`, `embeddings`, `multimodal`, `longContext` booleans plus a numeric
  `contextWindow`. Validated by `parseConfig`; documented in the JSON schema.
- Candidates that cannot serve a request are eliminated BEFORE execution:
  - explicit hard constraints via `CallOptions.routing.require`
    (undeclared = rejected);
  - request-inferred needs (tools → tools, image parts → vision,
    json_object → json, json_schema → structuredOutput, reasoning_effort →
    reasoning, stream() → streaming, embed() → embeddings) against DECLARED
    profiles only;
  - estimated input tokens vs declared `contextWindow`.
- New attempt outcome `capability_mismatch` + `route_skip` log reason
  `capability`.

### Added — cost / quality-aware policies

- Strategies: `cheapest`, `balanced`, `quality-first` (in addition to
  `fallback`, `round-robin`, `weighted`, `least-latency`). All keep fallback
  semantics after the ordered start.
- `estimateCostUsd()` export; pre-flight estimates use configured `pricing`
  (route id wins over provider model name).
- Constraints in `CallOptions.routing`: `maxCostUsd` (estimated),
  `maxLatencyMs` (observed p50), custom `filter` over a secret-free
  `RouteView`, and `task` for task-aware quality routing.

### Added — health tracking

- Per-route health in-process: success/failure totals, error tallies by kind,
  latency p50/p95/p99, stream TTFT percentiles (fixed-size ring buffers).
- Per-key cooldowns: rate-limit/auth/permission responses carrying
  `Retry-After` cool that key index down (capped at 5 min); later calls skip
  cooling keys without burning attempts (`key_skip` log event).
- Exposed via `stats().health`.

### Added — deadlines

- `CallOptions.deadlineMs`: wall-clock budget across routing, retries, key
  rotation, and fallback. Backoff sleeps are truncated at the deadline;
  per-attempt HTTP timeouts clamp to remaining budget; breach throws
  `DeadlineExceededError` (reported as kind `timeout` on `onFinish`). For
  streams the deadline governs acquiring the committed stream, not consuming it.

### Added — observability & dry-run

- `explain(req)` on `AIRouter`/`RoutingEngine`: dry-run routing decision —
  strategy, candidates with selected/rejected/backup status, human-readable
  reasons, estimated cost, observed latencies. Executes nothing and consumes
  no quota. Never contains credentials.
- `stats()` now includes `health` and `outcomes` sections.
- New `key_skip` lifecycle log event.

### Added — adaptive foundation

- `recordOutcome({ routeId, task?, success?, quality?, latencyMs?, costUsd? })`
  records application-observed outcomes (EMA per task+route). Feeds
  `quality-first` ordering; surfaces in `stats().outcomes`. Unknown route ids
  and out-of-range quality are ignored, never thrown.

### Fixed

- **Mid-stream caller abort now cancels the upstream connection.**
  `fetchWithTimeout` detached the caller-abort relay as soon as response
  headers arrived, so aborting during a streamed body left the socket open.
  Adapters now mark stream requests (`streaming: true`) to keep the relay
  attached for the body's lifetime; the engine additionally arms each attempt
  with a linked `AbortController` carrying caller cancellation + deadline.
- In-band mid-stream error objects from OpenAI-compatible backends
  (`{"error": {...}}` frames) are no longer silently dropped — they surface
  as retryable-classified `ProviderError`s after the commit boundary.
- Attempt notifications during key rotation now report the effective key
  index actually used (cooldown-aware), not the pre-rotation cursor value.

### Tests

- 84 new tests (282 total): capability elimination matrix, policy ordering,
  constraints, deadlines, health/cooldowns, explain dry-run, security leak
  assertions across every telemetry/error surface, a deterministic provider
  simulator driving failure scenarios (timeout→retry→fallback chains,
  post-commit stream death, key exhaustion, flaky recovery), and streaming
  edge cases (empty streams, usage-only chunks, early break, abort plumbing,
  malformed SSE frames).

### Migration

None required. Optional additions:

```ts
// config: declare what a route supports
{ id: "fast", provider: "groq", model: "...", capabilities: { tools: true, contextWindow: 128_000 } }

// calls: constrain or explain without executing
await router.complete(req, { routing: { require: { tools: true }, maxCostUsd: 0.01 } });
await router.explain(req);

// feedback: teach the router what worked
router.recordOutcome({ routeId: "fast", task: "chat", quality: 0.9 });
```

Python SDK note: `strategy` gained three values and routes gained a
`capabilities` object — port the validator changes before enabling these in
shared JSON configs.

## 0.1.0

Initial TypeScript reference implementation: fallback chains, strategies,
retries, key pools, circuit breaker, budgets, guardrails, response cache,
embeddings, raw escape hatch, provider presets, Redis store adapter,
conformance fixtures.
