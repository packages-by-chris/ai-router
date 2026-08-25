import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import type { LogEvent } from "../src/engine.js";
import type { ChatRequest } from "../src/types.js";
import { MockFetch, completionJson, jsonResponse, sseResponse } from "./helpers.js";
import { chunkJson } from "./helpers.js";

const cfg = () =>
  parseConfig({
    routes: [
      {
        id: "a",
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "k1",
        limit: { rpm: 0 === 0 ? undefined : undefined },
      },
      { id: "b", provider: "openai", model: "gpt-4o-mini", apiKey: "k2" },
    ],
  });

const req: ChatRequest = { model: "a", messages: [{ role: "user", content: "hi" }] };

function collector() {
  const events: LogEvent[] = [];
  return { events, onLog: (e: LogEvent) => events.push(e) };
}

describe("onLog lifecycle events", () => {
  test("complete success emits call_start and call-level logs work too", async () => {
    const engineLog = collector();
    const callLog = collector();
    const fetchMock = new MockFetch(jsonResponse(200, completionJson()));
    const sleep = async () => {};
    const engine = new RoutingEngine(cfg(), {
      fetchImpl: fetchMock.fetch as typeof fetch,
      sleep,
      onLog: engineLog.onLog,
    });
    await engine.complete(req, { onLog: callLog.onLog });
    expect(engineLog.events.map((e) => e.type)).toEqual(["call_start"]);
    // Both engine-level and call-level hooks fire.
    expect(callLog.events.map((e) => e.type)).toEqual(["call_start"]);
    const start = engineLog.events[0]!;
    if (start.type !== "call_start") throw new Error("unreachable");
    expect(start.op).toBe("complete");
    expect(start.model).toBe("a");
  });

  test("cache_hit logged when response cache serves", async () => {
    const log = collector();
    const cache = new Map<string, string>();
    const fetchMock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(cfg(), {
      fetchImpl: fetchMock.fetch as typeof fetch,
      onLog: log.onLog,
      responseCache: {
        get: (k) => cache.get(k),
        set: (k, v) => void cache.set(k, v),
        ttlMs: 1000,
      },
    });
    await engine.complete(req); // miss -> network -> set
    await engine.complete(req); // hit
    expect(fetchMock.calls).toHaveLength(1);
    expect(log.events.filter((e) => e.type === "cache_hit")).toHaveLength(1);
  });

  test("route_skip emitted for circuit_open skips", async () => {
    const log = collector();
    const fetchMock = new MockFetch(
      jsonResponse(500, { error: "boom" }),
      jsonResponse(500, { error: "boom" }),
      jsonResponse(500, { error: "boom" }), // a exhausts retries (try1 + 2 retries)
      jsonResponse(200, completionJson({ id: "from-b" })),
      jsonResponse(200, completionJson({ id: "from-b-2" })), // second call's b response
    );
    const engine = new RoutingEngine(cfg(), {
      fetchImpl: fetchMock.fetch as typeof fetch,
      sleep: async () => {},
      rng: () => 0,
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
      onLog: log.onLog,
    });
    // First call fails route a permanently (circuit opens), falls to b.
    await engine.complete(req);
    // Second call: a's circuit is open -> route_skip(circuit_open).
    await engine.complete(req);
    const skip = log.events.find((e) => e.type === "route_skip");
    expect(skip).toBeDefined();
    if (skip?.type !== "route_skip") return;
    expect(skip.routeId).toBe("a");
    expect(skip.reason).toBe("circuit_open");
  });

  test("attempt_retry logged with delayMs on retryable failures", async () => {
    const log = collector();
    const fetchMock = new MockFetch(
      jsonResponse(500, { error: "boom" }),
      jsonResponse(500, { error: "boom" }),
      jsonResponse(200, completionJson()), // third try succeeds
    );
    const singleRoute = parseConfig({
      routes: [{ id: "a", provider: "openai", model: "gpt-4o-mini", apiKey: "k" }],
    });
    const engine = new RoutingEngine(singleRoute, {
      fetchImpl: fetchMock.fetch as typeof fetch,
      sleep: async () => {},
      onLog: log.onLog,
    });
    await engine.complete(req);
    const retries = log.events.filter(
      (e): e is Extract<LogEvent, { type: "attempt_retry" }> => e.type === "attempt_retry",
    );
    expect(retries.length).toBe(2);
    for (const r of retries) {
      expect(r.routeId).toBe("a");
      expect(r.kind).toBe("server");
      expect(typeof r.delayMs).toBe("number");
    }
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[1]!.attempt).toBe(2);
  });

  test("guardrail_block logged with phase + guardrail name", async () => {
    const log = collector();
    const engine = new RoutingEngine(cfg(), {
      fetchImpl: new MockFetch().fetch as typeof fetch,
      onLog: log.onLog,
      guardrails: {
        input: [{ name: "block-all", check: () => ({ pass: false }) }],
      },
    });
    await expect(engine.complete(req)).rejects.toThrow();
    const block = log.events.at(-1)!;
    expect(block.type).toBe("guardrail_block");
    if (block.type !== "guardrail_block") return;
    expect(block.phase).toBe("input");
    expect(block.guardrail).toBe("block-all");
  });

  test("broken logger never breaks routing", async () => {
    const engine = new RoutingEngine(cfg(), {
      fetchImpl: new MockFetch(jsonResponse(200, completionJson())).fetch as typeof fetch,
      onLog: () => {
        throw new Error("logger exploded");
      },
    });
    await expect(engine.complete(req)).resolves.toBeTruthy();
  });

  test("stream() emits call_start; embed() emits call_start", async () => {
    const sLog = collector();
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${chunkJson()}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const sFetch = new MockFetch(() => sseResponse([])); // unused; custom below
    const sEngine = new RoutingEngine(cfg(), {
      fetchImpl: async () => new Response(streamBody, { status: 200 }),
      onLog: sLog.onLog,
    });
    for await (const _ of await sEngine.stream(req)) void _;
    expect(sLog.events[0]!.type).toBe("call_start");

    const eLog = collector();
    const eEngine = new RoutingEngine(
      parseConfig({
        routes: [{ id: "e", provider: "openai", model: "text-embedding-3-small", apiKey: "k" }],
      }),
      {
        fetchImpl: new MockFetch(
          jsonResponse(200, { data: [{ index: 0, embedding: [0.1] }], usage: {} }),
        ).fetch as typeof fetch,
        onLog: eLog.onLog,
      },
    );
    await eEngine.embed({ model: "e", input: "x" });
    expect(eLog.events[0]!.type).toBe("call_start");
    if (eLog.events[0]!.type !== "call_start") return;
    expect(eLog.events[0]!.op).toBe("embed");
    void sFetch;
  });
});

// keep helper import used even if some branches change
void sseResponse;
