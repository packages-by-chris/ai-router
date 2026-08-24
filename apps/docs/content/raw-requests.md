---
title: Raw requests
description: The router.raw escape hatch — verbatim provider bodies, undecorated responses.
---

# Raw requests

The unified layer deliberately does not half-model exotic features. For
everything it does not cover — Anthropic thinking blocks, server tools,
`json_schema` response formats, logprobs, beta endpoints — use the raw escape
hatch:

```ts
const response = await router.raw("smart", {
  path: "/messages",
  body: { /* your exact provider payload */ },
  headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
});

// Undecorated Response — read it yourself
const data = await response.json();
```

## Semantics

| Aspect | Behavior |
| --- | --- |
| Body | Objects are JSON-encoded; strings pass through **verbatim**. |
| Path | Relative to the route's base URL; defaults to the provider's chat endpoint. |
| Method | Default `"POST"`. |
| Headers | Merged over the adapter's auth + content-type defaults (route `headers` included). |
| Response | Undecorated `Response`, no translation. |

Deliberately **not** provided:

- No retries, no fallback. You picked the route; the request is yours.
- No unified types. What the provider returns is what you get.
- Rate limiting **still applies** — pre-flight rpm is checked and a spent
  budget throws [`RateLimitedError`](/docs/errors) with `retryAfterMs`.
- The key cursor is shared with unified calls, so raw requests rotate through
  the same pool instead of hammering key #1.

## When to use it

Reach for `raw` when a provider feature matters more than chain portability —
and keep it scoped to one route id so the rest of your traffic stays on the
unified surface.
