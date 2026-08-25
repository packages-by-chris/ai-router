---
title: Routing & fallback
description: How requests walk the fallback chain — retries, key rotation, and observability.
---

# Routing & fallback

When you call `router.complete({ model: "fast", ... })`, the engine resolves
the route id into a **chain**: the named route plus every route after it in
config order. The chain is walked until one route serves the request.

## Recovery layers

Failure recovery has three distinct layers, applied in order:

1. **Retry same route + key** — for retryable kinds (`rate_limit`, `server`,
   `network`, `timeout`), with exponential backoff (400 ms base, 8 s cap, 25%
   jitter). A provider-supplied `Retry-After` header overrides computed backoff.
2. **Rotate key on same route** — when the failure kind is key-related
   (`rate_limit`, `auth`, `permission`) and the pool has more keys. Entry into
   a request is round-robin across the pool; rotation skips forward.
3. **Next route in the chain** — after a route exhausts its retries, fall
   through to the next one.

If every route fails, `complete` throws
[`AllRoutesFailedError`](/docs/errors) carrying an `attempts[]` record of every
step.

## Strategies

`strategy` on the config changes how the chain start is picked; after the
start, fallback order is preserved:

- **`fallback`** (default) — strict order. The primary serves until it fails.
- **`round-robin`** — each request rotates the start cyclically. For pools of
  interchangeable replicas.
- **`weighted`** — each request picks the start proportionally to route
  `weight` (default 1), then falls back from there. Use `rng` in engine
  options to make selection deterministic in tests.
- **`least-latency`** — routes are tried fastest-first using a per-route
  latency EMA of observed successes (in-process). Unobserved routes are
  sampled before observed ones so every route gets data.

## Rate-limit and budget skip

Before any HTTP call, the engine checks the route's rpm/tpm budget (see
[Rate limiting](/docs/rate-limiting)) and its USD spend budget. An exhausted
route is **skipped without spending retries** (`outcome:
"skipped_rate_limit"` or `"skipped_budget"`) and the walk continues — a
throttled primary should not burn your backoff budget.

## Observability: onAttempt / onFinish

Both `complete` and `stream` accept per-call options with an `onAttempt` hook.
It fires for every routing decision:

```ts
const res = await router.complete(
  { model: "fast", messages },
  {
    onAttempt(event) {
      console.log(event);
      // { routeId: "fast",  provider: "openai",    model: "gpt-4o-mini",
      //   outcome: "retry", attempts: 1, keyIndex: 2,
      //   kind: "rate_limit", message: "429 ..." }
    },
    onFinish(summary) {
      // fired once when the call settles
      // { outcome: "ok", totalMs: 812, ttfbMs?: 240, routeId: "fast",
      //   attempts: 1, usage, costUsd?, cached? }
    },
  },
);
```

```ts
type AttemptOutcome =
  | "ok" | "error" | "retry"
  | "skipped_rate_limit" | "skipped_budget"
  | "circuit_open" | "unsupported";

interface AttemptEvent {
  routeId: string;
  provider: string;
  model: string;
  outcome: AttemptOutcome;
  /** Tries consumed on this route (0 for skips; 1-based otherwise). */
  attempts: number;
  keyIndex?: number;
  kind?: ErrorKind;
  message?: string;
}
```

This hook powers the live routing timeline in [`apps/example`](/docs/examples).

## Streaming caveat

Fallback is only possible **before** content reaches your caller. `router.stream`
resolves only once the serving route is committed — see
[Streaming](/docs/streaming) for the exact contract.

## Cancellation with AbortSignal

Pass a `signal` in `CallOptions` to cancel in-flight requests:

```ts
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

const res = await router.complete(
  { model: "fast", messages },
  { signal: controller.signal },
);
```

When the signal fires:
- In-flight HTTP requests are aborted immediately.
- The engine throws a `DOMException` with name `"AbortError"`.
- If the signal is already aborted before the call starts, the error is thrown synchronously before any HTTP request.

For streams, aborting the signal cancels the upstream connection. The stream
iterator stops yielding chunks and the error surfaces during iteration.

This integrates with framework request signals — e.g., Next.js `req.signal`:

```ts
export async function POST(req: Request) {
  const stream = await router.stream(
    { model: "fast", messages: [...] },
    { signal: req.signal }, // client disconnect aborts upstream
  );
  // ...
}
```
