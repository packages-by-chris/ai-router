---
title: Deadlines
description: Whole-call wall-clock budgets — deadlineMs across routing, retries, key rotation, and fallback.
---

# Deadlines

`deadlineMs` is a **wall-clock budget for the entire call**: candidate
selection, every retry, every key rotation, and fallback to later routes.

```ts
await router.complete(req, { deadlineMs: 5_000 });
await router.stream(req, { deadlineMs: 5_000 });
```

## What it enforces

1. **Backoff truncation.** A retry's exponential-backoff sleep is clamped to
   the remaining budget — the engine never sleeps past your deadline and
   then starts another attempt anyway.
2. **Per-attempt timeout clamping.** Each HTTP attempt gets
   `min(route.timeoutMs, remaining)` — a late attempt can't outlive the
   budget even if the route allows 30 s.
3. **In-flight abort.** The attempt in progress when the deadline hits is
   aborted at the transport level (the same signal that carries caller
   cancellation), so sockets don't linger.
4. **Fast fail between routes.** Once expired, no further route is tried;
   the call throws `DeadlineExceededError` immediately.

`onFinish` reports `kind: "timeout"` for deadline failures, so they group
with timeouts in your metrics.

## Streams

For `stream()`, the deadline governs **acquiring the committed stream**
(time-to-first-chunk, including all pre-commit fallback). Once the first
chunk reaches you the route is final; consuming the rest of the stream is
not deadline-bound — use `streamIdleTimeoutMs` for mid-stream stalls.

## Deadlines vs abort signals

Both work together on the same per-attempt controller:

| Mechanism | Semantics | Error surfaced |
|---|---|---|
| `signal` | "stop now, I changed my mind" | original abort reason |
| `deadlineMs` | "budget exhausted" | `DeadlineExceededError` |

Neither is ever retried or fallen back past — a caller's intended cutoff is
never overshot.
