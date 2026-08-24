---
title: Examples
description: Copy-paste recipes — fallback chains, key pools, Redis stores, streaming UIs.
---

# Examples

## Basic fallback chain

Three providers behind one logical model. Order = preference:

```ts
import { AIRouter } from "@ai-router/core";

const router = new AIRouter({
  routes: [
    { id: "fast", provider: "openai", model: "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY },
    { id: "backup1", provider: "gemini", model: "gemini-2.0-flash",
      apiKey: process.env.GEMINI_API_KEY },
    { id: "backup2", provider: "anthropic", model: "claude-haiku-4-5",
      apiKey: process.env.ANTHROPIC_API_KEY },
  ],
});

// Always address "fast" — the chain does the rest.
await router.complete({ model: "fast", messages });
```

## Key pools under load

Round-robin entry + rotation on throttled keys spreads traffic across a pool:

```json
{
  "routes": [
    {
      "id": "smart",
      "provider": "openai",
      "model": "gpt-4o",
      "apiKeys": ["sk-1", "sk-2", "sk-3", "sk-4"],
      "limit": { "rpm": 500 }
    }
  ]
}
```

A 429 on key #2 rotates to #3 without leaving the route; only a fully
exhausted pool falls through the chain.

## Streaming with a routing timeline

`onAttempt` gives you every decision; deltas interleave after commit:

```ts
const stream = await router.stream(req, {
  onAttempt(e) {
    timeline.push(`${e.routeId}:${e.outcome}${e.kind ? ` (${e.kind})` : ""}`);
  },
});

for await (const chunk of stream) {
  appendToUI(chunk.delta.content ?? "");
}
```

See it rendered live in [`apps/example`](../../apps/example/README.md) — the
repo's Next.js traffic console.

## Multi-replica budget with Redis

```ts
import { AIRouter } from "@ai-router/core";
import { RedisStore, ioredisClient } from "@ai-router/redis";
import Redis from "ioredis";

const router = new AIRouter(config, {
  store: new RedisStore({
    client: ioredisClient(new Redis(process.env.REDIS_URL)),
    onError: (err) => logger.warn({ err }, "rate-limit store"),
  }),
});
```

All replicas now share one sliding window per route.

## DeepSeek (or any OpenAI-shaped endpoint)

```json
{
  "routes": [
    { "id": "cheap", "provider": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat", "apiKey": "..." }
  ]
}
```

Works unchanged for Groq, Together, Fireworks, vLLM, Ollama — anything
speaking OpenAI chat completions.
