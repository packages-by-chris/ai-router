---
title: Circuit breaker
description: Automatically skip routes that are failing repeatedly.
---

# Circuit Breaker

Automatically skip routes that are failing repeatedly. Prevents wasted calls to a provider that's down or misconfigured.

## Setup

Pass `circuitBreaker` in `EngineOptions`:

```ts
import { AIRouter } from "@ai-router/core";

const router = new AIRouter(config, {
  circuitBreaker: {
    threshold: 5,     // open after 5 consecutive failures
    cooldownMs: 30000, // stay open for 30 seconds
  },
});
```

## How it works

1. **Closed** (normal). Every request attempts the route. Failures increment the counter.
2. **Open** (tripped). After `threshold` consecutive failures, the route is skipped for `cooldownMs`. The `onAttempt` callback receives `outcome: "skipped_rate_limit"` with `message: "circuit breaker open"`.
3. **Half-open** (probe). After cooldown expires, one request is allowed through as a probe.
   - **Success** → circuit closes, failure counter resets.
   - **Failure** → circuit reopens for another cooldown period.

## Options

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `threshold` | `number` | `Infinity` (disabled) | Consecutive failures before opening |
| `cooldownMs` | `number` | `30000` | How long to skip the route (ms) |

## Behavior

- Circuit state is **per-route**. A failure on route A does not affect route B.
- Failures are: `rate_limit`, `server`, `network`, `timeout`, `auth`, `permission`, `invalid_request`.
- Key rotation (via `isKeyRelatedKind`) does **not** reset the circuit — it's still a failure for that route.
- Success (`complete` returns or first stream chunk arrives) resets the failure counter to zero.
- The circuit breaker is **per-engine instance**. Each `AIRouter` has its own circuit state.

## Interaction with fallback

When a circuit opens, the engine moves to the next route in the chain:

```
route A (circuit open → skip)
route B (attempted) → success
```

If all routes are open, `AllRoutesFailedError` is thrown with all attempts recorded as `"skipped_rate_limit"`.

## Example: resilient multi-provider setup

```ts
const router = new AIRouter(
  {
    routes: [
      { id: "primary", provider: "openai", model: "gpt-4o", apiKey: "..." },
      { id: "backup", provider: "anthropic", model: "claude-haiku", apiKey: "..." },
      { id: "last", provider: "gemini", model: "gemini-2.0-flash", apiKey: "..." },
    ],
  },
  {
    circuitBreaker: { threshold: 3, cooldownMs: 60_000 },
  },
);
```

If OpenAI fails 3 times in a row, the next request skips straight to Anthropic. After 60s, one probe goes to OpenAI to check if it's back.

## Monitoring

Use `onAttempt` to track circuit breaker events:

```ts
const router = new AIRouter(config, {
  circuitBreaker: { threshold: 5, cooldownMs: 30_000 },
});

const res = await router.stream(req, {
  onAttempt(event) {
    if (event.outcome === "skipped_rate_limit" && event.message?.includes("circuit")) {
      console.warn(`Circuit open for ${event.routeId}`);
    }
  },
});
```
