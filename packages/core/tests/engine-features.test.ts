import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import type { RouterConfig } from "../src/config/schema.js";
import { AllRoutesFailedError, ProviderError } from "../src/errors.js";
import { RoutingEngine } from "../src/engine.js";
import type { AttemptEvent, RouterStats } from "../src/engine.js";
import { MockFetch, chunkJson, completionJson, jsonResponse, sseResponse } from "./helpers.js";
import { MemoryStore } from "../src/limiter/memory.js";

const noopSleep = async () => {};

function config(
  overrides: Array<Partial<RouterConfig["routes"][number]>> = [],
  strategy?: "fallback" | "round-robin",
): RouterConfig {
  const routes: RouterConfig["routes"] = [
    { id: "a", provider: "openai", model: "a-model", apiKey: "ka", maxRetries: 0 },
    {
      id: "b",
      provider: "openai-compatible",
      baseUrl: "https://b.example/v1",
      model: "b-model",
      apiKey: "kb",
      maxRetries: 0,
    },
    { id: "c", provider: "gemini", model: "c-model", apiKey: "kc", maxRetries: 0 },
  ];
  overrides.forEach((o, i) => Object.assign(routes[i]!, o));
  return parseConfig({ routes, ...(strategy ? { strategy } : {}) });
}

const req = { model: "a", messages: [{ role: "user" as const, content: "hi" }] };

describe("caller cancellation", () => {
  test("abort during a request propagates instead of retrying or falling back", async () => {
    // Route a hangs until the signal fires (like real fetch); b would succeed
    // if the engine wrongly fell back.
    const mock = new MockFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal!.reason ?? new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
      jsonResponse(200, completionJson()),
    );
    const controller = new AbortController();
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch, sleep: noopSleep });

    const pending = engine.complete(req, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.calls).toHaveLength(1); // no fallback fetch on b
  });

  test("pre-aborted signal throws without any fetch", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch });
    const controller = new AbortController();
    controller.abort();

    await expect(engine.complete(req, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mock.calls).toHaveLength(0);
  });

  test("abort during backoff stops the retry loop", async () => {
    const mock = new MockFetch(jsonResponse(500, {}));
    let sleeps = 0;
    const engine = new RoutingEngine(config([{ maxRetries: 3 }]), {
      fetchImpl: mock.fetch,
      sleep: async () => {
        sleeps++;
        throw new DOMException("cancelled", "AbortError");
      },
    });

    // Sleep throws inside the retry catch-block; must propagate untouched.
    await expect(engine.complete(req)).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.calls).toHaveLength(1);
    expect(sleeps).toBe(1);
  });

  test("stream honors pre-aborted signal", async () => {
    const mock = new MockFetch(sseResponse([chunkJson()]));
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch });
    const controller = new AbortController();
    controller.abort();

    await expect(engine.stream(req, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("openai-compatible labeling", () => {
  test("responses from compatible routes carry the route id", async () => {
    const mock = new MockFetch(
      jsonResponse(500, { error: { message: "a down" } }),
      jsonResponse(200, completionJson({ model: "b-model" })),
    );
    const events: AttemptEvent[] = [];
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch, sleep: noopSleep });

    const res = await engine.complete(req, { onAttempt: (e) => events.push(e) });
    expect(res.provider).toBe("b"); // was mislabeled "openai" before
    expect(events.map((e) => e.routeId)).toEqual(["a", "b"]);
  });

  test("known providers keep their provider id label", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch });
    const res = await engine.complete(req);
    expect(res.provider).toBe("openai");
  });
});

describe("circuit_open outcome", () => {
  test("open circuits emit circuit_open and skip without fetching", async () => {
    const failing = new MockFetch(
      jsonResponse(500, {}),
      jsonResponse(500, {}),
      jsonResponse(200, completionJson()), // c serves pass 1
      jsonResponse(200, completionJson()), // c serves pass 2
    );
    const engine = new RoutingEngine(config(), {
      fetchImpl: failing.fetch,
      sleep: noopSleep,
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });

    await engine.complete(req); // a fails, b fails, c ok -> a/b circuits open

    const events: AttemptEvent[] = [];
    const res = await engine.complete(req, { onAttempt: (e) => events.push(e) });
    expect(events.map((e) => e.outcome)).toEqual(["circuit_open", "circuit_open", "ok"]);
    expect(failing.calls).toHaveLength(4); // pass 2 fetched only c
    expect(res.provider).toBe("gemini");
  });
});

describe("stream idle timeout", () => {
  function stalledResponse(): Response {
    return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("pre-commit silence triggers fallback to the next route", async () => {
    const mock = new MockFetch(stalledResponse(), sseResponse([chunkJson()]));
    const cfg = config([{ streamIdleTimeoutMs: 25 }]);
    const engine = new RoutingEngine(cfg, { fetchImpl: mock.fetch, sleep: noopSleep });

    const stream = await engine.stream(req);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(mock.calls).toHaveLength(2); // a stalled, b served
    expect(chunks.map((c) => c.delta.content)).toContain("hi");
  });

  test("post-commit silence surfaces a timeout ProviderError", async () => {
    const encoder = new TextEncoder();
    const oneChunkThenSilence = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${chunkJson()}\n\n`));
        // never closes, never sends another event
      },
    });
    const mock = new MockFetch(
      new Response(oneChunkThenSilence, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const engine = new RoutingEngine(config([{ streamIdleTimeoutMs: 20 }]), {
      fetchImpl: mock.fetch,
      sleep: noopSleep,
    });

    const stream = await engine.stream(req);
    await expect(async () => {
      for await (const c of stream) void c;
    }).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("parseConfig strictness", () => {
  test("rejects unknown route fields with their path", () => {
    expect(() =>
      parseConfig({
        routes: [{ id: "x", provider: "openai", model: "m", apiKey: "k", maxRetry: 3 }],
      }),
    ).toThrow(/routes\[0\]\.maxRetry: unknown field/);
  });

  test("rejects unknown top-level and limit fields", () => {
    expect(() =>
      parseConfig({
        routes: [{ id: "x", provider: "openai", model: "m", apiKey: "k" }],
        strat: 1,
      }),
    ).toThrow(/config\.strat: unknown field/);
    expect(() =>
      parseConfig({
        routes: [
          { id: "x", provider: "openai", model: "m", apiKey: "k", limit: { rpm: 5, qps: 1 } },
        ],
      }),
    ).toThrow(/limit\.qps: unknown field/);
  });

  test("accepts streamIdleTimeoutMs and validates it", () => {
    const ok = parseConfig({
      routes: [{ id: "x", provider: "openai", model: "m", apiKey: "k", streamIdleTimeoutMs: 500 }],
    });
    expect(ok.routes[0]!.streamIdleTimeoutMs).toBe(500);
    expect(() =>
      parseConfig({
        routes: [{ id: "x", provider: "openai", model: "m", apiKey: "k", streamIdleTimeoutMs: 0 }],
      }),
    ).toThrow(/streamIdleTimeoutMs/);
  });

  test("validates strategy values and round-trips them", () => {
    expect(config(undefined, "round-robin").strategy).toBe("round-robin");
    expect(() =>
      parseConfig({
        routes: [{ id: "x", provider: "openai", model: "m", apiKey: "k" }],
        strategy: "random",
      }),
    ).toThrow(/strategy/);
  });
});

describe("AllRoutesFailedError.retryAfterMs", () => {
  test("carries the soonest Retry-After across attempts", async () => {
    const mock = new MockFetch(
      jsonResponse(429, {}, { "retry-after": "30" }),
      jsonResponse(429, {}, { "retry-after": "10" }),
    );
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch, sleep: noopSleep });

    try {
      await engine.complete(req);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AllRoutesFailedError);
      expect((err as AllRoutesFailedError).retryAfterMs).toBe(10_000);
    }
  });
});

describe("pricing / cost_usd", () => {
  test("complete attaches cost using route-id pricing", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson())); // 3 in / 2 out
    const engine = new RoutingEngine(config(), {
      fetchImpl: mock.fetch,
      pricing: { a: { input: 1, output: 2 } },
    });

    const res = await engine.complete(req);
    expect(res.cost_usd).toBe(0.000007); // 3/1M*$1 + 2/1M*$2
  });

  test("model-name pricing works when route id misses", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(config(), {
      fetchImpl: mock.fetch,
      pricing: { "a-model": { input: 1, output: 0 } },
    });
    const res = await engine.complete(req);
    expect(res.cost_usd).toBe(0.000003);
  });

  test("usage-bearing stream chunks carry cost", async () => {
    const events = [
      chunkJson(),
      JSON.stringify({
        id: "x",
        model: "a-model",
        choices: [],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      }),
    ];
    const mock = new MockFetch(sseResponse(events));
    const engine = new RoutingEngine(config(), {
      fetchImpl: mock.fetch,
      pricing: { a: { input: 3, output: 7 } },
    });

    const stream = await engine.stream(req);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks.at(-1)!.cost_usd).toBe(3);
  });

  test("no pricing configured -> no cost field", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch });
    const res = await engine.complete(req);
    expect(res.cost_usd).toBeUndefined();
  });
});

describe("strategy: round-robin", () => {
  test("rotates the chain start across requests while keeping fallback order", async () => {
    // One engine: the rotation cursor lives on the engine, not per request.
    // Scripted across three requests:
    //   req1 chain [a,b,c]: a 500, b 500, c ok
    //   req2 chain [b,c]:   b 500, c ok
    //   req3 chain [c,a,b]: c ok immediately
    const mock = new MockFetch(
      jsonResponse(500, {}),
      jsonResponse(500, {}),
      jsonResponse(200, completionJson()),
      jsonResponse(500, {}),
      jsonResponse(200, completionJson()),
      jsonResponse(200, completionJson()),
    );
    const engine = new RoutingEngine(config(undefined, "round-robin"), {
      fetchImpl: mock.fetch,
      sleep: noopSleep,
    });

    await engine.complete(req);
    expect(mock.calls[0]!.url).toContain("api.openai.com"); // starts at a

    const res2 = await engine.complete(req);
    expect(mock.calls[3]!.url).toContain("b.example"); // starts at b
    expect(res2.provider).toBe("gemini");

    const res3 = await engine.complete(req);
    expect(mock.calls[5]!.url).toContain("generativelanguage.googleapis.com"); // starts at c
    expect(res3.provider).toBe("gemini");
  });

  test("default strategy keeps strict primary-first order", async () => {
    const mock = new MockFetch(
      jsonResponse(200, completionJson()),
      jsonResponse(200, completionJson()),
    );
    const engine = new RoutingEngine(config(), { fetchImpl: mock.fetch });
    await engine.complete(req);
    await engine.complete(req);
    expect(mock.calls.every((c) => c.url.includes("api.openai.com"))).toBe(true);
  });
});

describe("stats()", () => {
  test("reports strategy, circuit breakers, key cursors, limiter totals", async () => {
    const store = new MemoryStore({ now: () => 0 });
    const mock = new MockFetch(
      jsonResponse(500, {}),
      jsonResponse(200, completionJson()),
    );
    const engine = new RoutingEngine(config(), {
      fetchImpl: mock.fetch,
      sleep: noopSleep,
      store,
      circuitBreaker: { threshold: 2, cooldownMs: 60_000 },
    });

    await engine.complete(req); // a errors once, b serves
    const stats: RouterStats = await engine.stats();

    expect(stats.strategy).toBe("fallback");
    expect(stats.circuitBreakers).toEqual([
      expect.objectContaining({ routeId: "a", failures: 1, open: false }),
    ]);
    expect(Object.keys(stats.keyCursors)).toEqual(expect.arrayContaining(["a", "b"]));
    expect(stats.rateLimits).toEqual({});
  });
});
