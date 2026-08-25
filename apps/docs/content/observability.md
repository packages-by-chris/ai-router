---
title: Observability
description: Structured lifecycle logs, per-call hooks, and engine stats.
---

# Observability

Three complementary hooks, each scoped to a different question:

| Hook | Answers | Fires |
|---|---|---|
| `onLog` | "What is the engine doing right now?" | Structured lifecycle events (starts, skips, retries, cache hits, guardrail blocks) |
| `onAttempt` | "What happened on each route?" | Once per routing decision/retry per call |
| `onFinish` | "How did the call settle?" | Exactly once when the call settles |

Plus `middleware.beforeRequest/afterResponse` for per-HTTP-attempt hooks and
`stats()` for point-in-time snapshots.

## `onLog` — structured lifecycle events

Set at the engine level, per call, or both (both fire; per-call first):

```ts
import { AIRouter, type LogEvent } from "@ai-router/core";

const router = new AIRouter(config, {
  onLog: (event: LogEvent) => {
    // Ship to your pipeline. Never throws back into routing.
    console.log(JSON.stringify(event));
  },
});

// Per-call hook fires in addition:
await router.complete(req, { onLog: (e) => metrics.record(e) });
```

Event shapes:

```ts
type LogEvent =
  | { type: "call_start"; ts: number; op: "complete" | "stream" | "embed"; model: string }
  | { type: "cache_hit"; ts: number; model: string }
  | {
      type: "route_skip";
      ts: number;
      routeId: string;
      provider: string;
      reason: "rate_limit" | "budget" | "circuit_open" | "unsupported";
    }
  | {
      type: "attempt_retry";
      ts: number;
      routeId: string;
      provider: string;
      attempt: number;
      kind?: ErrorKind;
      delayMs?: number;   // backoff about to be slept
    }
  | {
      type: "guardrail_block";
      ts: number;
      phase: "input" | "output";
      guardrail: string;
      reason?: string;
    };
```

Guarantees: callbacks are wrapped — a throwing logger never breaks routing.

## `onAttempt` — routing decisions

Fires for every route outcome: `"ok"`, `"error"`, `"retry"`,
`"skipped_rate_limit"`, `"skipped_budget"`, `"circuit_open"`,
`"unsupported"`:

```ts
await router.complete(req, {
  onAttempt(e) {
    if (e.outcome === "retry") console.warn(`retry ${e.routeId} after ${e.kind}`);
    if (e.outcome === "ok") console.log(`${e.routeId} ok in ${e.latencyMs}ms`);
  },
});
```

## `onFinish` — settlement summary

Exactly one event per call with total wall time, serving route, usage and cost:

```ts
await router.complete(req, {
  onFinish(s) {
    dashboard.observe(s.totalMs, s.routeId, s.usage?.total_tokens, s.costUsd);
    if (s.cached) return; // served from response cache
  },
});
```

Streams also report `ttfbMs` (time to committed first chunk).

## `stats()` — point-in-time snapshot

Circuit-breaker states (including graduated-cooldown breach counts), key-pool cursors, per-route latency EMAs, and limiter totals (when the store supports snapshots):

```ts
const stats = await router.stats();
for (const cb of stats.circuitBreakers) {
  if (cb.open) alert(`${cb.routeId} open for ${cb.openUntil - Date.now()}ms`);
}
```

## Wiring to external systems

The hooks are plain functions — forward to OpenTelemetry, Datadog,
Langfuse, or anything else without adapters from this package:

```ts
import { logs } from "@opentelemetry-api"; // your dependency, not ours

new AIRouter(config, {
  onLog: (e) => logger.emit({ severityText: "INFO", body: e }),
  onAttempt: (a) => tracer.span(`route:${a.routeId}`).addEvent(a.outcome),
  onFinish: (s) => histogram.record(s.totalMs, { route: s.routeId }),
});
```
