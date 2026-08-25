import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine, type AttemptEvent } from "../src/engine.js";
import { MockFetch, jsonResponse } from "./helpers.js";

const cfg = parseConfig({
  routes: [
    { id: "o", provider: "openai", model: "text-embedding-3-small", apiKey: "ko" },
    {
      id: "b",
      provider: "openai-compatible",
      baseUrl: "https://b.example/v1",
      model: "b-embed",
      apiKey: "kb",
    },
    { id: "g", provider: "gemini", model: "gemini-embedding-001", apiKey: "kg" },
  ],
});

const req = { model: "o", input: ["hello", "world"] };

describe("OpenAI embeddings", () => {
  test("translates to /embeddings and normalizes the response", async () => {
    const mock = new MockFetch(
      jsonResponse(200, {
        object: "list",
        model: "text-embedding-3-small",
        data: [
          { index: 0, embedding: [0.1, 0.2] },
          { index: 1, embedding: [0.3, 0.4] },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 },
      }),
    );
    const engine = new RoutingEngine(cfg, { fetchImpl: mock.fetch });

    const res = await engine.embed(req);
    expect(mock.calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({
      model: "text-embedding-3-small",
      input: ["hello", "world"],
    });
    expect(res.provider).toBe("openai");
    expect(res.data).toEqual([
      { index: 0, embedding: [0.1, 0.2] },
      { index: 1, embedding: [0.3, 0.4] },
    ]);
    expect(res.usage).toEqual({ prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 });
  });

  test("cost_usd attached when pricing configured", async () => {
    const mock = new MockFetch(
      jsonResponse(200, {
        data: [{ index: 0, embedding: [1] }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      }),
    );
    const engine = new RoutingEngine(cfg, {
      fetchImpl: mock.fetch,
      pricing: { o: { input: 0.02, output: 0 } },
    });
    const res = await engine.embed(req);
    expect(res.cost_usd).toBe(0.02);
  });
});

describe("Gemini embeddings", () => {
  test("batchEmbedContents maps to the unified shape", async () => {
    const mock = new MockFetch(
      jsonResponse(200, {
        embeddings: [{ values: [1, 2] }, { values: [3, 4] }],
      }),
    );
    const engine = new RoutingEngine(cfg, { fetchImpl: mock.fetch });

    const res = await engine.embed({ model: "g", input: ["hello", "world"] });
    expect(mock.calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    const body = JSON.parse(String(mock.calls[0]!.init?.body));
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toEqual({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "hello" }] },
    });
    expect(res.provider).toBe("gemini");
    expect(res.data).toEqual([
      { index: 0, embedding: [1, 2] },
      { index: 1, embedding: [3, 4] },
    ]);
  });
});

describe("embed fallback machinery", () => {
  test("falls through routes lacking embed support (anthropic)", async () => {
    const withAnthropic = parseConfig({
      routes: [
        { id: "a", provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "ka", maxRetries: 0 },
        {
          id: "b",
          provider: "openai-compatible",
          baseUrl: "https://b.example/v1",
          model: "b-embed",
          apiKey: "kb",
        },
      ],
    });
    const mock = new MockFetch(jsonResponse(200, { data: [{ index: 0, embedding: [9] }] }));
    const events: AttemptEvent[] = [];
    const engine = new RoutingEngine(withAnthropic, { fetchImpl: mock.fetch });

    const res = await engine.embed({ model: "a", input: "hi" }, {
      onAttempt: (e) => events.push(e),
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toContain("b.example");
    expect(events[0]).toMatchObject({ routeId: "a", outcome: "unsupported" });
    expect(res.provider).toBe("b");
  });

  test("retries a retryable failure before falling back", async () => {
    const cfgRetry = parseConfig({
      routes: [
        { id: "o", provider: "openai", model: "e", apiKey: "ko", maxRetries: 1 },
        { id: "g", provider: "gemini", model: "ge", apiKey: "kg", maxRetries: 0 },
      ],
    });
    const mock = new MockFetch(
      jsonResponse(500, {}),
      jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }),
    );
    const engine = new RoutingEngine(cfgRetry, { fetchImpl: mock.fetch, sleep: async () => {} });
    const res = await engine.embed({ model: "o", input: "x" });
    expect(mock.calls).toHaveLength(2);
    expect(res.provider).toBe("openai");
  });
});
