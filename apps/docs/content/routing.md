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

## Rate-limit skip

Before any HTTP call, the engine checks the route's rpm/tpm budget (see
[Rate limiting](/docs/rate-limiting)). An exhausted route is **skipped without
spending retries** and the walk continues — a throttled primary should not burn
your backoff budget.

## Observability: onAttempt

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
  },
);
```

```ts
type AttemptOutcome = "ok" | "error" | "retry" | "skipped_rate_limit" | "unsupported";

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
