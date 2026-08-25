---
title: Capability routing
description: Declare what each model supports and let the router eliminate incompatible candidates before any network I/O.
---

# Capability routing

Capability routing removes candidates that **cannot serve a request** before
the engine spends a single attempt on them. A tools request never hits a
vision-only model; an oversized prompt never hits a 32k-context model; a
`stream()` call never lands on a route that can't stream.

## Declaring capabilities

Add `capabilities` to any route:

```ts
const router = new AIRouter({
  routes: [
    {
      id: "fast", provider: "groq", model: "llama-3.3-70b",
      apiKey: "${GROQ_API_KEY}",
      capabilities: { tools: true, streaming: true, contextWindow: 128_000 },
    },
    {
      id: "smart", provider: "anthropic", model: "claude-sonnet-4",
      apiKey: "${ANTHROPIC_API_KEY}",
      capabilities: {
        tools: true, vision: true, structuredOutput: true,
        reasoning: true, streaming: true, contextWindow: 200_000,
      },
    },
  ],
});
```

| Capability | Eliminates routes when… |
|---|---|
| `tools` | the request carries `tools` |
| `vision` | messages contain `image_url` parts |
| `json` | `response_format` is `{ type: "json_object" }` |
| `structuredOutput` | `response_format` is `{ type: "json_schema" }` |
| `reasoning` | `reasoning_effort` is set |
| `streaming` | the call goes through `router.stream()` |
| `embeddings` | the call goes through `router.embed()` |
| `contextWindow` | estimated input tokens exceed it (≈3.5 chars/token heuristic) |

Also available but not request-inferred: `audio`, `multimodal`,
`longContext` — declare them for documentation and for use with
[`routing.require`](#explicit-requirements).

## The compatibility rule

**A route without declared capabilities is always eligible.** The router
cannot prove a mismatch, so it never filters unknown profiles — this keeps
existing configs working unchanged.

Declaring capabilities asserts the full boolean profile: an omitted key means
"not supported" for elimination purposes. Declare everything a model
actually supports. Partial declarations are valid (`{ vision: true }` alone
means no-tools) — just be accurate.

## Explicit requirements

Per-call requirements are **hard constraints**: a candidate must declare the
capability, or it is rejected — including candidates with no declared
profile at all.

```ts
await router.complete(req, {
  routing: {
    require: { tools: true },
  },
});
```

If nothing satisfies the requirement, the call fails fast with
`AllRoutesFailedError` where every attempt record carries outcome
`capability_mismatch` — no provider was contacted.

Inference vs requirement semantics in one table:

| Source | Undeclared route | Declared conflicting route |
|---|---|---|
| Request inference (tools in messages…) | stays eligible | eliminated |
| `routing.require.tools: true` | eliminated | must be `true` |

## Custom filters

For anything capability metadata can't express, add a predicate over a
secret-free view of each candidate:

```ts
await router.complete(req, {
  routing: {
    filter: (route) => !route.id.startsWith("eu-"),
    // route = { id, provider, model, weight?, capabilities? }
    // deliberately excludes keys and headers
  },
});
```

Skipped candidates surface as attempts with outcome
`capability_mismatch`, log events with reason `"capability"` or `"filter"`,
and appear with rejection reasons in [`explain()`](/docs/dry-run).
