---
title: Dry-run routing
description: explain() — the full routing decision without executing anything, and recordOutcome() for teaching the router what worked.
---

# Dry-run routing

`router.explain(req)` evaluates the entire candidate pipeline — strategy
ordering, capability gate, custom filter, constraints, circuit-breaker
state, budget/tpm windows — **without executing a request and without
consuming rate-limit quota**.

```ts
const decision = await router.explain({
  model: "smart",
  messages,
});

console.log(JSON.stringify(decision, null, 2));
```

```json
{
  "model": "smart",
  "strategy": "cheapest",
  "task": "summarize",
  "candidates": [
    {
      "routeId": "fast",
      "provider": "groq",
      "model": "llama-3.3-70b",
      "status": "rejected",
      "reasons": ["request needs vision but route does not declare it"],
      "estimatedCostUsd": 0.000012
    },
    {
      "routeId": "smart",
      "provider": "anthropic",
      "model": "claude-sonnet-4",
      "status": "selected",
      "reasons": [
        "declared capabilities satisfy the request",
        "estimated cost $0.000045"
      ],
      "estimatedCostUsd": 0.000045,
      "observedLatencyMs": 912
    },
    {
      "routeId": "backup",
      "provider": "deepseek",
      "model": "deepseek-chat",
      "status": "backup",
      "reasons": []
    }
  ],
  "selected": { "…same as candidates[selected]" : "…" }
}
```

Candidate statuses:

| Status | Meaning |
|---|---|
| `selected` | first candidate that passed every read-only gate |
| `rejected` | eliminated before selection — `reasons` say why |
| `backup` | next in line after selection (unevaluated) |

Guarantees:

- **No execution** — no fetch happens; hanging providers can't slow it down.
- **No quota consumption** — rpm is never taken; budget/tpm checks are
  read-only.
- **No credentials** — output contains route ids, provider labels, model
  names, reasons, numbers. Nothing else.

The real call may still differ from the plan if an rpm limit trips or a
provider fails mid-walk — explain shows intent, not fate.

## Recording outcomes

The other half of dry-run: teach the router what actually worked so
`quality-first` ordering improves (see
[Cost, latency & quality](/docs/routing-policies#quality-first--adaptive-foundation)).

```ts
router.recordOutcome({
  routeId: summary.routeId!,   // from onFinish or stats frames
  task: "support-ticket",      // optional bucket
  success: true,
  quality: 0.94,               // application-defined, [0,1]
  latencyMs: summary.totalMs,
  costUsd: res.cost_usd,
});
```

Unknown route ids are ignored; invalid values are dropped; nothing ever
throws — feedback must never break traffic.
