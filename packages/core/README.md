# @ai-router-sdk/core

Provider-agnostic AI routing core: fallback chains, key pools, rate limiting, and unified streaming across OpenAI, Anthropic, Gemini, Azure, Bedrock, Vertex, and OpenAI-compatible endpoints.

Zero runtime dependencies — built on standard Web `fetch` and WebStreams.

## Installation

```bash
npm install @ai-router-sdk/core
```

## Quick Start

```ts
import { AIRouter, parseConfig, streamText } from "@ai-router-sdk/core";

// 1. Define configuration with fallback routes & rate limits
const config = parseConfig({
  routes: [
    {
      id: "fast",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY,
      limit: { rpm: 500 },
    },
    {
      id: "backup",
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
  ],
});

// 2. Initialize router
const router = new AIRouter(config);

// 3. Complete requests with automatic fallback
const response = await router.complete({
  model: "fast", // route id
  messages: [{ role: "user", content: "Explain quantum computing in one sentence." }],
});

console.log(response.choices[0]?.message.content);

// 4. Or stream tokens cleanly
const stream = await router.stream({
  model: "fast",
  messages: [{ role: "user", content: "Count from 1 to 5." }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.delta.content ?? "");
}

// Or collect text all at once:
// const fullText = await streamText(await router.stream({ model: "fast", messages: [...] }));
```

## Features

- **Multi-Provider Unified API**: OpenAI, Anthropic, Gemini, AWS Bedrock, Google Vertex AI, Azure OpenAI, and OpenAI-compatible providers (Groq, DeepSeek, Together, Ollama, etc.).
- **Reliable Fallback Chains & Key Pools**: Automatic key rotation and failover across providers.
- **Rate Limiting & Budgets**: In-memory token bucket / sliding window, expandable to distributed Redis via `@ai-router-sdk/redis`.
- **Latency, Cost & Quality Routing**: Strategies like `cheapest`, `least-latency`, `quality-first`, and `balanced`.
- **Tool Calling & Multimodal**: Seamless normalization across all supported providers.
- **Zero Runtime Dependencies**: Ultra-lightweight and runs in Node.js, Deno, Bun, Cloudflare Workers, and edge runtimes.

## License

MIT
