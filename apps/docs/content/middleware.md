---
title: Middleware
description: Per-attempt lifecycle hooks for logging, metrics, and debugging.
---

# Middleware

Per-attempt lifecycle hooks. Fire before and after every adapter call — useful for logging, metrics, header injection, and debugging.

## Setup

Pass `middleware` in `EngineOptions` (second argument to `AIRouter`):

```ts
import { AIRouter } from "@ai-router/core";

const router = new AIRouter(config, {
  middleware: {
    beforeRequest(ctx) {
      console.log(`→ ${ctx.routeId} (${ctx.provider}) attempt #${ctx.attempt}`);
    },
    afterResponse(ctx, res) {
      console.log(`← ${ctx.routeId} ok — ${res.usage?.total_tokens ?? "?"} tokens`);
    },
  },
});
```

## `beforeRequest(ctx)`

Fires before each adapter HTTP call. Receives:

| Field | Type | Description |
| --- | --- | --- |
| `routeId` | `string` | The route being attempted |
| `provider` | `string` | Provider id (`openai`, `anthropic`, etc.) |
| `model` | `string` | Provider-side model name |
| `request` | `ChatRequest` | The unified request being sent |
| `attempt` | `number` | 1-based attempt number for this route |

Throw an error in `beforeRequest` to abort the attempt. The error propagates as a `ProviderError` with kind `"unknown"`.

## `afterResponse(ctx, response)`

Fires after a successful adapter response. Same `ctx` as above, plus the `ChatResponse`.

For streams, `afterResponse` fires at the commit boundary (after the first chunk arrives). The `response` is a synthetic `ChatResponse` built from the first chunk's metadata.

## Common patterns

### Request logging

```ts
middleware: {
  beforeRequest(ctx) {
    const start = Date.now();
    console.log(`[${ctx.routeId}] start`);
    // Store start time for afterResponse if needed
  },
  afterResponse(ctx, res) {
    console.log(`[${ctx.routeId}] done — ${res.usage?.total_tokens ?? "?"} tokens`);
  },
}
```

### Metrics collection

```ts
const metrics = { attempts: 0, tokens: 0 };

const router = new AIRouter(config, {
  middleware: {
    beforeRequest() { metrics.attempts++; },
    afterResponse(_, res) {
      if (res.usage) metrics.tokens += res.usage.total_tokens;
    },
  },
});
```

### Custom headers per provider

```ts
middleware: {
  beforeRequest(ctx) {
    // Attach a custom header based on the provider
    // (Note: this doesn't directly modify headers — use route.headers for that)
    if (ctx.provider === "anthropic") {
      console.log("Anthropic request:", ctx.request.messages.length, "messages");
    }
  },
}
```

## Notes

- Middleware is **per-attempt**, not per-request. If a request retries or falls back, middleware fires again for each attempt.
- Errors thrown in `beforeRequest` are caught by the engine and classified as route failures (same as network errors).
- `afterResponse` does not fire for failed attempts — only for successful ones.
- Middleware is stateless by design. Use closures or external state for metrics/logging.
