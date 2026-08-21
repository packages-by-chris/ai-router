import { describe, expect, test } from "bun:test";
import { AllRoutesFailedError, ConfigError, ProviderError, RateLimitedError } from "../src/errors.js";
import type { AttemptEvent } from "../src/engine.js";
import { MemoryStore } from "../src/limiter/memory.js";
import { RoutingEngine } from "../src/engine.js";
import type { RouterConfig } from "../src/config/schema.js";
import { MockFetch, chunkJson, completionJson, jsonResponse, sseResponse } from "./helpers.js";

const noopSleep = async () => {};

function config(overrides: Partial<RouterConfig["routes"][number]>[] = []): RouterConfig {
  const defaults: RouterConfig["routes"] = [
    {
      id: "a",
      provider: "openai",
      model: "a-model",
      apiKey: "ka",
      maxRetries: 0,
    },
    {
      id: "b",
      provider: "openai-compatible",
      baseUrl: "https://b.example/v1",
      model: "b-model",
      apiKey: "kb",
      maxRetries: 0,
    },
  ];
  const routes = defaults.map((d, i) => ({ ...d, ...overrides[i] }));
  // Overrides beyond the two defaults are complete extra routes.
  for (const extra of overrides.slice(2)) {
    routes.push(extra as RouterConfig["routes"][number]);
  }
  return { routes };
}

const req = { model: "a", messages: [{ role: "user" as const, content: "hi" }] };

describe("RoutingEngine.complete", () => {
  test("falls back to the next route after a server error", async () => {
    const mock = new MockFetch(
      jsonResponse(500, { error: { message: "overloaded" } }),
      jsonResponse(200, completionJson({ model: "b-model" })),
    );
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch, sleep: noopSleep });

    const res = await engine.complete(req);
    expect(res.provider).toBe("openai");
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.url).toContain("api.openai.com");
    expect(mock.calls[1]!.url).toContain("b.example");
  });

  test("rotates keys within a pool on 429 before falling back", async () => {
    const mock = new MockFetch(
      jsonResponse(429, { error: { message: "quota" } }, { "retry-after": "0" }),
      jsonResponse(200, completionJson()),
    );
    const engine = new RoutingEngine(
      config([{ apiKey: undefined, apiKeys: ["k1", "k2"], maxRetries: 1 }]),
      { fetchImpl: mock.fetch, sleep: noopSleep, rng: () => 0 },
    );

    const res = await engine.complete(req);
    expect(res.choices[0]!.message.content).toBe("hello");
    expect(mock.calls).toHaveLength(2);
    expect(mock.header(0, "authorization")).toBe("Bearer k1");
    expect(mock.header(1, "authorization")).toBe("Bearer k2");
  });

  test("skips a route whose rate limit is exhausted, without calling it", async () => {
    const store = new MemoryStore({ now: () => 0 });
    // Exhaust route "a"'s rpm budget (limit 1) before the request.
    await store.take("a:rpm", 1, 60_000, 1);

    const mock = new MockFetch(jsonResponse(200, completionJson({ model: "b-model" })));
    const engine = new RoutingEngine(config([{ limit: { rpm: 1 } }]), {
      fetchImpl: mock.fetch,
      sleep: noopSleep,
      store,
    });

    const res = await engine.complete(req);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toContain("b.example");
    expect(res.model).toBe("b-model");
  });

  test("accounts tpm post-hoc and gates the next request", async () => {
    let t = 0;
    const store = new MemoryStore({ now: () => t });
    const mock = new MockFetch(
      jsonResponse(200, completionJson()), // usage total_tokens: 5
      jsonResponse(200, completionJson({ model: "b-model" })),
    );
    const engine = new RoutingEngine(config([{ limit: { tpm: 5 } }]), {
      fetchImpl: mock.fetch,
      sleep: noopSleep,
      store,
    });

    await engine.complete(req); // records 5 tokens against a:tpm
    t = 1;
    const res2 = await engine.complete(req); // estimate(~4) + 5 > 5 -> skip a, use b
    expect(mock.calls[0]!.url).toContain("api.openai.com");
    expect(mock.calls[1]!.url).toContain("b.example");
    expect(res2.model).toBe("b-model");
  });

  test("throws AllRoutesFailedError with a full attempt trail", async () => {
    const mock = new MockFetch(
      jsonResponse(500, { error: { message: "a down" } }),
      jsonResponse(500, { error: { message: "b down" } }),
    );
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch, sleep: noopSleep });

    try {
      await engine.complete(req);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AllRoutesFailedError);
      const attempts = (err as AllRoutesFailedError).attempts;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ routeId: "a", outcome: "error", kind: "server" });
      expect(attempts[1]).toMatchObject({ routeId: "b", outcome: "error", kind: "server" });
    }
  });

  test("does not retry non-retryable kinds (auth) and moves on", async () => {
    const mock = new MockFetch(
      jsonResponse(401, { error: { message: "bad key" } }),
      jsonResponse(200, completionJson({ model: "b-model" })),
    );
    const engine = new RoutingEngine(config([{ maxRetries: 3 }]), {
      fetchImpl: mock.fetch,
      sleep: noopSleep,
    });

    await engine.complete(req);
    expect(mock.calls).toHaveLength(2); // one attempt on a, one on b
  });

  test("unknown model id names the known routes", async () => {
    const engine = new RoutingEngine(config(), { fetchImpl: new MockFetch().fetch });
    try {
      await engine.complete({ model: "nope", messages: [] });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("a, b");
    }
  });

  test("records unsupported providers as attempts and keeps routing", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson({ model: "b-model" })));
    const engine = new RoutingEngine(
      // Engine consumes parsed configs and does not re-validate providers,
      // so a future/unknown provider id exercises the registry-gap path.
      config([{ id: "future", provider: "cohere" as never, model: "command-x" }]),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );
    // Requesting "future" -> cohere unsupported -> route b is next in chain.
    const res = await engine.complete({ model: "future", messages: [{ role: "user", content: "hi" }] });
    expect(res.model).toBe("b-model");
  });

  test("emits attempt events: retry, error, skip, ok", async () => {
    const store = new MemoryStore({ now: () => 0 });
    await store.take("a:rpm", 1, 60_000, 1); // exhaust a's rpm -> skip
    const mock = new MockFetch(
      jsonResponse(500, { error: { message: "b down" } }), // b try 1
      jsonResponse(429, { error: { message: "b busy" } }, { "retry-after": "0" }), // b try 2 (retryable, but maxRetries=0)
      jsonResponse(200, completionJson({ model: "g-model" })),
    );
    const engine = new RoutingEngine(
      config([
        { limit: { rpm: 1 } },
        {},
        { id: "g", provider: "openai-compatible", baseUrl: "https://g.example/v1", model: "g-model", apiKey: "kg" },
      ]),
      { fetchImpl: mock.fetch, sleep: noopSleep, store },
    );

    const events: AttemptEvent[] = [];
    const res = await engine.complete(req, { onAttempt: (e) => events.push(e) });

    expect(res.model).toBe("g-model");
    expect(events).toEqual([
      expect.objectContaining({ routeId: "a", outcome: "skipped_rate_limit" }),
      expect.objectContaining({ routeId: "b", outcome: "error", attempts: 1, kind: "server" }),
      // g: 429 on key 0 -> rotate -> success on key 1
      expect.objectContaining({ routeId: "g", outcome: "retry", attempts: 1, kind: "rate_limit", keyIndex: 0 }),
      expect.objectContaining({ routeId: "g", outcome: "ok", attempts: 2, keyIndex: 1 }),
    ]);
  });

  test("emits retry events within a route before success", async () => {
    const mock = new MockFetch(
      jsonResponse(429, { error: { message: "busy" } }),
      jsonResponse(200, completionJson()),
    );
    const engine = new RoutingEngine(
      config([{ apiKeys: ["k1", "k2"], maxRetries: 1 }]),
      { fetchImpl: mock.fetch, sleep: noopSleep, rng: () => 0 },
    );

    const events: AttemptEvent[] = [];
    await engine.complete(req, { onAttempt: (e) => events.push(e) });

    expect(events).toEqual([
      expect.objectContaining({ outcome: "retry", attempts: 1, keyIndex: 0, kind: "rate_limit" }),
      expect.objectContaining({ outcome: "ok", attempts: 2, keyIndex: 1 }),
    ]);
  });

  test("stream emits the same event trail pre-commit", async () => {
    const mock = new MockFetch(
      jsonResponse(500, { error: { message: "down" } }),
      sseResponse([chunkJson()]),
    );
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch, sleep: noopSleep });

    const events: AttemptEvent[] = [];
    const stream = await engine.stream(req, { onAttempt: (e) => events.push(e) });
    for await (const c of stream) void c;

    expect(events.map((e) => e.outcome)).toEqual(["error", "ok"]);
  });

  test("529 overloaded is retryable: retries then falls back", async () => {
    const mock = new MockFetch(
      jsonResponse(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      jsonResponse(200, completionJson({ model: "b-model" })),
    );
    const engine = new RoutingEngine(
      config([{ id: "claude", provider: "anthropic", model: "claude-sonnet-4-6", maxRetries: 0 }]),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );

    const res = await engine.complete({ model: "claude", messages: [{ role: "user", content: "hi" }] });
    expect(mock.calls[0]!.url).toContain("/messages");
    expect(mock.calls[1]!.url).toContain("b.example");
    expect(res.model).toBe("b-model");
  });
});

describe("RoutingEngine.raw", () => {
  test("sends the body verbatim to the route's provider, returns the Response untouched", async () => {
    const mock = new MockFetch(jsonResponse(418, { weird: true }));
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch });

    const resp = await engine.raw("a", { body: { custom_field: [1, 2] }, headers: { "x-test": "1" } });

    expect(resp.status).toBe(418); // non-2xx passes through, no retry/fallback
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(mock.header(0, "authorization")).toBe("Bearer ka");
    expect(mock.header(0, "x-test")).toBe("1");
    expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({ custom_field: [1, 2] });
  });

  test("uses each provider's default endpoint path", async () => {
    const mock = new MockFetch(jsonResponse(200, {}), jsonResponse(200, {}), jsonResponse(200, {}));
    const engine = new RoutingEngine(
      config([
        {},
        {},
        { id: "g", provider: "gemini", model: "gemini-2.0-flash", apiKey: "kg" },
      ]),
      { fetchImpl: mock.fetch },
    );

    await engine.raw("b", {}); // anthropic-compatible? no: b is openai-compatible with baseUrl
    expect(mock.calls[0]!.url).toBe("https://b.example/v1/chat/completions");

    await engine.raw("g", {});
    expect(mock.calls[1]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    expect(mock.header(1, "x-goog-api-key")).toBe("kg");
  });

  test("rpm budget gates raw calls (RateLimitedError), no fetch happens", async () => {
    const store = new MemoryStore({ now: () => 0 });
    await store.take("a:rpm", 1, 60_000, 1); // exhaust
    const mock = new MockFetch();
    const engine = new RoutingEngine(config([{ limit: { rpm: 1 } }]), {
      fetchImpl: mock.fetch,
      store,
    });

    try {
      await engine.raw("a", { body: {} });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).routeId).toBe("a");
    }
    expect(mock.calls).toHaveLength(0);
  });

  test("unknown route id names the known routes", async () => {
    const engine = new RoutingEngine(config(), { fetchImpl: new MockFetch().fetch });
    try {
      await engine.raw("nope", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("a, b");
    }
  });
});

describe("RoutingEngine.stream", () => {
  test("falls back before the first token and streams from the next route", async () => {
    const mock = new MockFetch(
      jsonResponse(500, { error: { message: "down" } }),
      sseResponse([chunkJson(), chunkJson({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })]),
    );
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch, sleep: noopSleep });

    const stream = await engine.stream(req);
    const chunks = [];
    for await (const c of stream) chunks.push(c);

    expect(mock.calls).toHaveLength(2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.delta.content).toBe("hi");
    expect(chunks[1]!.finish_reason).toBe("stop");
  });

  test("propagates mid-stream errors after commit (no silent provider swap)", async () => {
    const encoder = new TextEncoder();
    // Deliver one chunk, then error on the NEXT read (error() would discard
    // queued chunks, so use pull to fire only after the queue drains).
    const flaky = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${chunkJson()}\n\n`));
      },
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const mock = new MockFetch(new Response(flaky, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch, sleep: noopSleep });

    const stream = await engine.stream(req);
    const chunks = [];
    try {
      for await (const c of stream) chunks.push(c);
      throw new Error("should have thrown");
    } catch (err) {
      expect(chunks).toHaveLength(1); // first chunk delivered, then the failure
      expect((err as Error).message).toContain("connection reset");
    }
  });

  test("throws AllRoutesFailedError when every route fails pre-commit", async () => {
    const mock = new MockFetch(
      jsonResponse(429, { error: { message: "q" } }),
      jsonResponse(429, { error: { message: "q" } }),
    );
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch, sleep: noopSleep });

    try {
      await engine.stream(req);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AllRoutesFailedError);
      expect((err as AllRoutesFailedError).attempts).toHaveLength(2);
      expect((err as AllRoutesFailedError).attempts[0]!.kind).toBe("rate_limit");
    }
  });

  test("records usage from the trailing usage-only chunk", async () => {
    let t = 0;
    const store = new MemoryStore({ now: () => t });
    const events = [
      chunkJson(),
      JSON.stringify({ id: "x", model: "a-model", choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
    ];
    const mock = new MockFetch(sseResponse(events));
    const engine = new RoutingEngine(config([{ limit: { tpm: 5 } }]), {
      fetchImpl: mock.fetch,
      sleep: noopSleep,
      store,
    });

    const stream = await engine.stream(req);
    for await (const c of stream) void c;

    t = 1;
    // a:tpm now holds 5 of 5 -> next request on route a must be gated.
    const blocked = await store.take("a:tpm", 1, 60_000, 5);
    expect(blocked.allowed).toBe(false);
  });
});
