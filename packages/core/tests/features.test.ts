import { describe, expect, test, vi } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import type { RouterConfig } from "../src/config/schema.js";
import { RoutingEngine } from "../src/engine.js";
import type { AttemptEvent, CallSummaryEvent } from "../src/engine.js";
import {
  translateRequest as anthropicTranslate,
  translateResponse as anthropicResponse,
} from "../src/providers/anthropic.js";
import {
  translateRequest as geminiTranslate,
  translateResponse as geminiResponse,
} from "../src/providers/gemini.js";
import { translateRequest as openaiTranslate } from "../src/providers/openai.js";
import { AzureAdapter } from "../src/providers/azure.js";
import { MemoryStore } from "../src/limiter/memory.js";
import { MockFetch, chunkJson, completionJson, jsonResponse, sseResponse } from "./helpers.js";

const noopSleep = async () => {};

function routes(overrides: Array<Partial<RouterConfig["routes"][number]>> = []): RouterConfig["routes"] {
  const base: RouterConfig["routes"] = [
    { id: "a", provider: "openai", model: "a-model", apiKey: "ka", maxRetries: 0 },
    {
      id: "b",
      provider: "openai-compatible",
      baseUrl: "https://b.example/v1",
      model: "b-model",
      apiKey: "kb",
      maxRetries: 0,
    },
  ];
  overrides.forEach((o, i) => Object.assign(base[i]!, o));
  return base;
}

const req = { model: "a", messages: [{ role: "user" as const, content: "hi" }] };

// --------------------------------------------------------------- json_schema

describe("structured output", () => {
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const rf = {
    type: "json_schema" as const,
    json_schema: { name: "person", schema, strict: true },
  };

  test("openai passes response_format through verbatim", () => {
    const body = openaiTranslate({ ...req, response_format: rf }, "gpt-4o-mini", false);
    expect(body.response_format).toEqual(rf);
  });

  test("gemini maps schema to responseMimeType + responseJsonSchema", () => {
    const body = geminiTranslate({ ...req, response_format: rf }, "gemini-2.0-flash", false);
    expect(body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    });
  });
});

// ------------------------------------------------------------------ reasoning

describe("reasoning_effort mapping", () => {
  test("openai forwards reasoning_effort", () => {
    const body = openaiTranslate({ ...req, reasoning_effort: "high" }, "o4-mini", false);
    expect(body.reasoning_effort).toBe("high");
  });

  test("anthropic maps effort to thinking budget and drops sampling params", () => {
    const body = anthropicTranslate(
      { ...req, reasoning_effort: "medium", temperature: 0.3, top_p: 0.9 },
      "claude-sonnet-4", false,
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 12288 });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  test("gemini maps effort to thinkingConfig with thoughts included", () => {
    const body = geminiTranslate({ ...req, reasoning_effort: "low" }, "gemini-2.5-flash", false);
    expect(body.generationConfig).toMatchObject({
      thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
    });
  });

  test("anthropic thinking blocks surface as message.reasoning", () => {
    const res = anthropicResponse(
      {
        id: "msg_1",
        model: "claude-sonnet-4",
        content: [
          { type: "thinking", thinking: "let me think..." },
          { type: "text", text: "answer" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude-sonnet-4",
    );
    expect(res.choices[0]!.message.reasoning).toBe("let me think...");
    expect(res.choices[0]!.message.content).toBe("answer");
  });

  test("anthropic stream thinking deltas arrive as delta.reasoning", async () => {
    const events = [
      JSON.stringify({ type: "message_start", message: { id: "m", model: "claude-x", usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const mock = new MockFetch(sseResponse(events));
    const engine = new RoutingEngine(
      parseConfig({ routes: [{ id: "a", provider: "anthropic", model: "claude-x", apiKey: "k", maxRetries: 0 }] }),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );
    const stream = await engine.stream(req);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks.some((c) => c.delta.reasoning === "hmm")).toBe(true);
    expect(chunks.some((c) => c.delta.content === "hi")).toBe(true);
  });

  test("openai-compatible reasoning_content deltas surface as reasoning", async () => {
    const events = [
      JSON.stringify({
        id: "x", model: "b-model",
        choices: [{ index: 0, delta: { reasoning_content: "thinking..." }, finish_reason: null }],
      }),
      JSON.stringify({
        id: "x", model: "b-model",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      }),
    ];
    const mock = new MockFetch(sseResponse(events));
    const engine = new RoutingEngine(
      parseConfig({ routes: [routes()[1]!] }),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );
    const stream = await engine.stream({ model: "b", messages: req.messages });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks[0]!.delta.reasoning).toBe("thinking...");
  });

  test("gemini thought parts surface as reasoning; usage carries thought tokens", () => {
    const res = geminiResponse(
      {
        responseId: "r1",
        modelVersion: "gemini-2.5-flash",
        candidates: [{
          content: { parts: [{ text: "thought", thought: true }, { text: "visible" }] },
          finishReason: "STOP",
        }],
        usageMetadata: {
          promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9, thoughtsTokenCount: 3,
        },
      },
      "gemini-2.5-flash",
    );
    expect(res.choices[0]!.message.reasoning).toBe("thought");
    expect(res.choices[0]!.message.content).toBe("visible");
    expect(res.usage!.reasoning_tokens).toBe(3);
  });
});

// -------------------------------------------------------------- prompt caching

describe("prompt caching (anthropic)", () => {
  test("system cache_control stamps ephemeral marker on system blocks", () => {
    const body = anthropicTranslate(
      {
        ...req,
        messages: [
          { role: "system", content: "be terse", providerOptions: { anthropic: { cache_control: true } } },
          { role: "user", content: "hi" },
        ],
      },
      "claude-sonnet-4", false,
    );
    expect(body.system).toEqual([
      { type: "text", text: "be terse", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("message-level cache_control stamps the last block of that message", () => {
    const body = anthropicTranslate(
      {
        ...req,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "doc1" }, { type: "text", text: "doc2" }],
            providerOptions: { anthropic: { cache_control: true } },
          },
        ],
      },
      "claude-sonnet-4", false,
    );
    const blocks = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    expect(blocks[0]!.cache_control).toBeUndefined();
    expect(blocks[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("cache token usage flows through responses and streams", () => {
    const res = anthropicResponse(
      {
        id: "m", model: "claude-x", content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100, output_tokens: 10,
          cache_read_input_tokens: 50, cache_creation_input_tokens: 20,
        },
      },
      "claude-x",
    );
    expect(res.usage).toMatchObject({
      prompt_tokens: 100, completion_tokens: 10,
      total_tokens: 180, cached_tokens: 50, cache_write_tokens: 20,
    });
  });
});

describe("usage details (openai family)", () => {
  test("cached/reasoning tokens parse from *_details", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson({
      usage: {
        prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    })));
    const engine = new RoutingEngine(parseConfig({ routes: [routes()[0]!] }), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    const res = await engine.complete(req);
    expect(res.usage).toMatchObject({ cached_tokens: 80, reasoning_tokens: 12 });
  });
});

// ------------------------------------------------------------ providerOptions

describe("providerOptions passthrough", () => {
  test("openai merges its namespace into the body", () => {
    const body = openaiTranslate(
      { ...req, providerOptions: { openai: { parallel_tool_calls: false } } },
      "gpt-4o-mini", false,
    );
    expect(body.parallel_tool_calls).toBe(false);
  });

  test("anthropic merges its namespace last (explicit keys win)", () => {
    const body = anthropicTranslate(
      { ...req, max_tokens: 10, providerOptions: { anthropic: { metadata: { user_id: "u1" } } } },
      "claude-sonnet-4", false,
    );
    expect(body.metadata).toEqual({ user_id: "u1" });
    expect(body.max_tokens).toBe(10);
  });

  test("azure merges azure over openai namespace", async () => {
    const adapter = new AzureAdapter();
    const route = {
      id: "az", provider: "azure" as const, model: "gpt-4o-deploy",
      baseUrl: "https://res.openai.azure.com", apiVersion: "2024-10-21",
      keyPool: ["k"], headers: {}, maxRetries: 0, timeoutMs: 5000, limits: {},
    };
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    await adapter.complete(route, "k", {
      ...req,
      providerOptions: {
        openai: { seed: 1, shared: "from-openai" },
        azure: { shared: "from-azure" },
      },
    }, { fetchImpl: mock.fetch });
    const body = JSON.parse(String(mock.calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body.seed).toBe(1);
    expect(body.shared).toBe("from-azure");
  });
});

// --------------------------------------------------------------------- azure

describe("azure provider", () => {
  function azureRoutes(): RouterConfig["routes"] {
    return [{
      id: "az", provider: "azure", model: "gpt-4o-deploy",
      baseUrl: "https://res.openai.azure.com", apiVersion: "2024-10-21",
      apiKey: "kaz", maxRetries: 0,
    }];
  }

  test("config requires baseUrl + apiVersion for azure", () => {
    expect(() =>
      parseConfig({ routes: [{ id: "x", provider: "azure", model: "d", apiKey: "k", baseUrl: "https://r.openai.azure.com" }] }),
    ).toThrow(/apiVersion/);
    expect(() =>
      parseConfig({ routes: [{ id: "x", provider: "azure", model: "d", apiKey: "k", apiVersion: "2024-10-21" }] }),
    ).toThrow(/baseUrl/);
  });

  test("apiVersion rejected on non-azure providers", () => {
    expect(() =>
      parseConfig({
        routes: [{ id: "x", provider: "openai", model: "m", apiKey: "k", apiVersion: "2024-10-21" }],
      }),
    ).toThrow(/apiVersion.*only valid when provider is "azure"/s);
  });

  test("wire shape: deployment URL, api-version query, api-key header", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(parseConfig({ routes: azureRoutes() }), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    await engine.complete({ model: "az", messages: req.messages });

    const call = mock.calls[0]!;
    expect(call.url).toBe(
      "https://res.openai.azure.com/openai/deployments/gpt-4o-deploy/chat/completions?api-version=2024-10-21",
    );
    expect((call.init?.headers as Record<string, string>)["api-key"]).toBe("kaz");
    expect((call.init?.headers as Record<string, string>).authorization).toBeUndefined();
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o-deploy");
  });

  test("embeddings hit the deployment embeddings endpoint", async () => {
    const mock = new MockFetch(jsonResponse(200, {
      data: [{ index: 0, embedding: [0.1] }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    }));
    const engine = new RoutingEngine(parseConfig({ routes: azureRoutes() }), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    await engine.embed({ model: "az", input: "hello" });
    expect(mock.calls[0]!.url).toBe(
      "https://res.openai.azure.com/openai/deployments/gpt-4o-deploy/embeddings?api-version=2024-10-21",
    );
  });

  test("raw path override keeps api-version appended", async () => {
    const mock = new MockFetch(jsonResponse(200, { ok: true }));
    const engine = new RoutingEngine(parseConfig({ routes: azureRoutes() }), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    await engine.raw("az", { path: "/openai/files?x=1" });
    expect(mock.calls[0]!.url).toBe("https://res.openai.azure.com/openai/files?x=1&api-version=2024-10-21");
  });

  test("responses are labeled provider azure", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(parseConfig({ routes: azureRoutes() }), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    const res = await engine.complete({ model: "az", messages: req.messages });
    expect(res.provider).toBe("azure");
  });
});

// ----------------------------------------------------------------- strategies

describe("strategy: weighted", () => {
  test("rng-driven start selection respects weights then falls back in order", async () => {
    // weights a=3, b=1; rng=0.5 lands in b's cumulative range ([0.75,1)).
    const mock = new MockFetch(
      jsonResponse(200, completionJson()),
      jsonResponse(200, completionJson()),
    );
    const engine = new RoutingEngine(
      parseConfig({ routes: routes([{ weight: 3 }, { weight: 1 }]), strategy: "weighted" }),
      { fetchImpl: mock.fetch, sleep: noopSleep, rng: () => 0.8 },
    );
    await engine.complete(req);
    expect(mock.calls[0]!.url).toContain("b.example");
  });

  test("rng below primary weight starts at the primary", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(
      parseConfig({ routes: routes([{ weight: 3 }, { weight: 1 }]), strategy: "weighted" }),
      { fetchImpl: mock.fetch, sleep: noopSleep, rng: () => 0.5 },
    );
    await engine.complete(req);
    expect(mock.calls[0]!.url).toContain("api.openai.com");
  });
});

describe("strategy: least-latency", () => {
  test("samples unobserved routes, then orders observed-fastest first", async () => {
    // a is slow (clock jumps 40ms during its attempt), b never called in
    // pass 1 (a succeeds). Pass 2 must start at b (unobserved -> explore).
    const mock = new MockFetch(
      jsonResponse(200, completionJson()),
      jsonResponse(200, completionJson()),
    );
    const slowFetch: typeof mock.fetch = async (url, init) => {
      if (url.includes("api.openai.com")) vi.setSystemTime(Date.now() + 40);
      return mock.fetch(url, init);
    };
    vi.useFakeTimers();
    try {
      const engine = new RoutingEngine(
        parseConfig({ routes: routes(), strategy: "least-latency" }),
        { fetchImpl: slowFetch, sleep: noopSleep },
      );

      await engine.complete(req); // a serves; latency EMA recorded
      const s1 = await engine.stats();
      expect(s1.latencies.a).toBeGreaterThan(0);

      await engine.complete(req); // b explored first now
      expect(mock.calls[1]!.url).toContain("b.example");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------- graduated cooldowns

describe("graduated circuit breaker cooldowns", () => {
  test("cooldown doubles per breach up to maxCooldownMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      // Pass 1: a 500, b 500, c ok. Pass 2 (+1001ms): a 500, b 500, c ok.
      const mock = new MockFetch(
        jsonResponse(500, {}),
        jsonResponse(500, {}),
        jsonResponse(200, completionJson()),
        jsonResponse(500, {}),
        jsonResponse(500, {}),
        jsonResponse(200, completionJson()),
      );
      const engine = new RoutingEngine(routes3(), {
        fetchImpl: mock.fetch, sleep: noopSleep,
        circuitBreaker: { threshold: 1, cooldownMs: 1_000, maxCooldownMs: 8_000 },
      });

      await engine.complete(req); // a fails -> opens 1s; b fails -> opens 1s; c ok
      const s1 = await engine.stats();
      expect(s1.circuitBreakers.map((c) => ({ id: c.routeId, opens: c.opens })))
        .toEqual([{ id: "a", opens: 1 }, { id: "b", opens: 1 }]);
      expect(s1.circuitBreakers.find((c) => c.routeId === "a")!.openUntil - 1_000_000).toBe(1_000);

      // Advance past cooldown, fail again -> doubled to 2_000.
      vi.setSystemTime(1_001_001);
      await engine.complete(req); // a fails again (opens=2), b fails, c ok
      const s2 = await engine.stats();
      expect(s2.circuitBreakers.find((c) => c.routeId === "a")!.opens).toBe(2);
      expect(s2.circuitBreakers.find((c) => c.routeId === "a")!.openUntil - 1_001_001).toBeGreaterThanOrEqual(2_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

function routes3(): RouterConfig {
  return parseConfig({
    routes: [
      { id: "a", provider: "openai", model: "a-model", apiKey: "ka", maxRetries: 0 },
      {
        id: "b", provider: "openai-compatible", baseUrl: "https://b.example/v1",
        model: "b-model", apiKey: "kb", maxRetries: 0,
      },
      { id: "c", provider: "gemini", model: "c-model", apiKey: "kc", maxRetries: 0 },
    ],
  });
}

// -------------------------------------------------------------------- budgets

describe("route spend budgets", () => {
  test("exhausted usd budget skips the route pre-flight (skipped_budget)", async () => {
    const pricing = { a: { input: 1_000_000, output: 0 }, b: { input: 1, output: 0 } };
    const store = new MemoryStore();
    const mock = new MockFetch(
      jsonResponse(200, completionJson()), // a serves call 1 ($1 spend)
      jsonResponse(200, completionJson()), // b serves call 2
    );
    const cfg = parseConfig({
      routes: routes([{ budget: { usd: 0.5 } }]),
    });
    const engine = new RoutingEngine(cfg, {
      fetchImpl: mock.fetch, sleep: noopSleep, store, pricing,
    });

    await engine.complete(req); // cost = 3 prompt * $1/M? -> input price 1e6 USD/M * 3 tokens = $3? see below

    // With input price 1,000,000 USD per 1M tokens, 3 prompt tokens = $3.
    // Budget $0.5 is already exceeded -> next call skips a entirely.
    const events: AttemptEvent[] = [];
    const res = await engine.complete(req, { onAttempt: (e) => events.push(e) });
    expect(events[0]).toMatchObject({ routeId: "a", outcome: "skipped_budget" });
    expect(res.provider).toBe("b");
  });

  test("budget without store.used support fails open", async () => {
    const pricing = { a: { input: 1_000_000, output: 0 } };
    const mock = new MockFetch(
      jsonResponse(200, completionJson()),
      jsonResponse(200, completionJson()),
    );
    // Store without a used() implementation -> budget cannot read back spend.
    const noReadBackStore = {
      take: async () => ({ allowed: true, retryAfterMs: 0 }),
      record: async () => {},
    };
    const engine = new RoutingEngine(
      parseConfig({ routes: routes([{ budget: { usd: 0.000001 } }]) }),
      { fetchImpl: mock.fetch, sleep: noopSleep, pricing, store: noReadBackStore },
    );
    await engine.complete(req);
    await engine.complete(req); // still routed to a (no read-back -> no gate)
    expect(mock.calls.every((c) => c.url.includes("api.openai.com"))).toBe(true);
  });
});

// ------------------------------------------------------------- response cache

describe("response cache", () => {
  test("identical complete() calls hit the cache once configured", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const backing = new Map<string, string>();
    const summaries: CallSummaryEvent[] = [];
    const engine = new RoutingEngine(parseConfig({ routes: [routes()[0]!] }), {
      fetchImpl: mock.fetch,
      sleep: noopSleep,
      responseCache: {
        get: (k) => backing.get(k),
        set: (k, v) => void backing.set(k, v),
        ttlMs: 60_000,
      },
    });

    const r1 = await engine.complete(req, { onFinish: (s) => summaries.push(s) });
    const r2 = await engine.complete(req, { onFinish: (s) => summaries.push(s) });
    expect(mock.calls).toHaveLength(1);
    expect(r2.id).toBe(r1.id);
    expect(summaries[0]!.cached).toBeUndefined();
    expect(summaries[1]!.cached).toBe(true);
  });

  test("different requests bypass the cache", async () => {
    const mock = new MockFetch(
      jsonResponse(200, completionJson()),
      jsonResponse(200, completionJson()),
    );
    const backing = new Map<string, string>();
    const engine = new RoutingEngine(parseConfig({ routes: [routes()[0]!] }), {
      fetchImpl: mock.fetch,
      sleep: noopSleep,
      responseCache: {
        get: (k) => backing.get(k),
        set: (k, v) => void backing.set(k, v),
        ttlMs: 60_000,
      },
    });
    await engine.complete(req);
    await engine.complete({ ...req, temperature: 0.7 });
    expect(mock.calls).toHaveLength(2);
  });
});

// ------------------------------------------------------------------- summary

describe("onFinish summary", () => {
  test("failed path reports attempts count", async () => {
    const mock = new MockFetch(jsonResponse(500, {}), jsonResponse(500, {}));
    const captured: CallSummaryEvent[] = [];
    const engine = new RoutingEngine(routes3(), { fetchImpl: mock.fetch, sleep: noopSleep });
    await expect(
      engine.complete(req, { onFinish: (s) => captured.push(s) }),
    ).rejects.toBeTruthy();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.outcome).toBe("failed");
    expect(captured[0]!.attempts).toBe(3); // a, b, c all failed
    expect(captured[0]!.totalMs).toBeGreaterThanOrEqual(0);
  });

  test("stream success reports ttfbMs", async () => {
    const mock = new MockFetch(sseResponse([chunkJson()]));
    const captured: CallSummaryEvent[] = [];
    const engine = new RoutingEngine(parseConfig({ routes: [routes()[0]!] }), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    const stream = await engine.stream(req, { onFinish: (s) => captured.push(s) });
    for await (const c of stream) void c;
    expect(captured[0]).toMatchObject({ outcome: "ok", routeId: "a" });
    expect(typeof captured[0]!.ttfbMs).toBe("number");
  });
});
