---
title: Introduction
description: What ai-router is, why it exists, and how to install it.
---

# Introduction

`@ai-router/core` is a provider-agnostic AI routing layer. You describe your
provider routes once — in order of preference — and every request walks that
chain automatically: retrying transient failures, rotating API keys when a pool
is throttled, and falling back to the next provider when a route is exhausted.

The unified surface intentionally mirrors the OpenAI chat-completions shape
(the de facto lingua franca), so translation layers stay thin and existing
OpenAI-shaped code ports over with minimal changes.

## Why

Calling providers directly couples you to their wire format, their failure
modes, and their rate limits. ai-router sits between your app and the
providers and owns the boring parts:

- **Fallback chains** — OpenAI down? The same logical `model` silently serves from Anthropic or Gemini.
- **Key pools** — multiple keys per route, round-robin on entry, rotated on `rate_limit` / `auth` / `permission` failures.
- **Rate limiting** — pre-flight rpm gating and post-hoc tpm accounting, in-process or Redis-backed for multi-replica deployments.
- **Unified streaming** — one async chunk shape across all providers, with a committed-stream contract (see [Streaming](/docs/streaming)).
- **Typed errors** — a classified error taxonomy (`rate_limit`, `server`, `network`, …) instead of string matching on provider messages.

## Install

```sh
npm install @ai-router/core          # routing core
npm install @ai-router/redis         # optional: shared rate-limit state
```

Zero runtime dependencies. Node 18+, Bun, Deno, and edge runtimes are
supported — the core uses only `fetch` and WebStreams.

## Quickstart

```ts
import { AIRouter } from "@ai-router/core";

const router = new AIRouter({
  routes: [
    { id: "fast", provider: "openai", model: "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY },
    // openai-compatible: any OpenAI-shaped base URL
    { id: "cheap", provider: "openai-compatible", baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat", apiKey: process.env.DEEPSEEK_API_KEY },
    { id: "backup", provider: "anthropic", model: "claude-haiku-4-5",
      apiKey: process.env.ANTHROPIC_API_KEY },
  ],
});

// "fast" tries DeepSeek if OpenAI fails, then Anthropic.
const res = await router.complete({
  model: "fast",
  messages: [{ role: "user", content: "hi" }],
});

console.log(res.choices[0].message.content);
console.log(res.provider); // which provider actually served it
```

`model` in requests is a **route id** from your config — not a provider model
name. That indirection is what makes fallback possible.

## Where to next

- [Configuration](/docs/configuration) — the full config schema and validation rules
- [Routing & fallback](/docs/routing) — retries, key rotation, and the recovery layers
- [Examples](/docs/examples) — copy-paste recipes for common setups
- [Gateway](/docs/gateway) — expose your config as an OpenAI-compatible endpoint for tools like Cursor or OpenCode
