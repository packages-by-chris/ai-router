---
title: Cost, latency & quality
description: Pricing-aware and outcome-aware routing — cheapest, balanced, quality-first strategies plus per-call cost/latency constraints.
---

# Cost, latency & quality routing

Strategies decide **where traffic lands first**; fallback order is preserved
after that start. The default signals are config order and observed latency;
this page covers the three policies that add pricing and quality.

## Pricing

Cost routing reads the `pricing` engine option — USD per 1M tokens keyed by
route id (wins) or provider model name:

```ts
const router = new AIRouter(config, {
  pricing: {
    fast: { input: 0.15, output: 0.6 },
    smart: { input: 3, output: 15 },
    // cache tiers exist too: cache_read, cache_write
  },
});
```

Pre-flight estimates use a token heuristic for input; output is assumed to
be `max_tokens` when set, otherwise ≈ input size. Actual spend accounting
(from provider usage reports) remains the source of truth for budgets.

## `cheapest`

Priced routes by estimated per-request USD ascending. Unpriced routes follow
in config order; with no pricing at all it degrades to plain `fallback`.

```ts
const config = { strategy: "cheapest", routes };
```

## `balanced`

Score per candidate in [0,1]:

```
0.5 · cost + 0.3 · speed + 0.2 · reliability
```

Each component is rank-normalized across the candidate slice; unpriced,
unobserved, or unrated candidates get a neutral 0.5 so partial data never
disqualifies anyone. Reliability comes from observed success rates (health
tracking), which is why balanced gets smarter as traffic flows.

## `quality-first` — adaptive foundation

Routes by **your** measured quality, not a universal score. Record outcomes
after calls and the router aggregates them as EMAs per `(task, route)`:

```ts
const res = await router.complete(req, { routing: { task: "summarize" } });
router.recordOutcome({
  routeId: "smart",        // the route that served (from onFinish/stats)
  task: "summarize",
  success: true,
  quality: 0.92,           // your eval harness, human rating, downstream signal…
  latencyMs: 850,
  costUsd: res.cost_usd,
});
```

- Quality is application-defined — the router never invents one.
- Task buckets are independent: a model great at summarizing can be poor at
  tool loops.
- No data → graceful fallback to `balanced` scoring.
- Deterministic EMA math; no opaque ML.

This is the full feedback loop: request → decision → execution → recorded
outcome → better future ordering.

## Per-call constraints

Any call can eliminate candidates before execution:

```ts
await router.complete(req, {
  routing: {
    maxCostUsd: 0.01,     // estimated cost ceiling (priced routes only)
    maxLatencyMs: 1_500,  // observed p50 ceiling (observed routes only)
    filter: (route) => !route.id.startsWith("eu-"), // custom, secret-free view
    task: "summarize",    // bucket for quality-first
    require: { tools: true }, // see capability routing
  },
});
```

Unpriced/unobserved routes pass their respective constraint (the router
can't know what it hasn't seen). Rejected candidates appear in
[`explain()`](/docs/dry-run) with reasons.

## Combining

Strategies and constraints compose freely: run `cheapest` globally but cap
any single call's latency, or use `balanced` with a hard tools requirement —
elimination happens before ordering.
