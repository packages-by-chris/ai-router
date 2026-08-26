import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import type { ChatRequest } from "../src/types.js";
import { OutcomeTracker } from "../src/routing/outcomes.js";
import { balancedScores } from "../src/routing/order.js";
import { inferTask } from "../src/routing/state.js";
import { replayStrategy } from "../src/routing/replay.js";
import type { FetchLike } from "../src/http/request.js";
import { completionJson, jsonResponse } from "./helpers.js";

const noopSleep = async () => {};

function twoRoutes() {
  return [
    { id: "a", provider: "openai", model: "ma", apiKey: "ka", maxRetries: 0 },
    {
      id: "b",
      provider: "openai-compatible",
      baseUrl: "https://b.test/v1",
      model: "mb",
      apiKey: "kb",
      maxRetries: 0,
    },
  ] as const;
}

const req: ChatRequest = { model: "a", messages: [{ role: "user", content: "hi" }] };

function urlsFetch(urls: string[]): FetchLike {
  return async (url) => {
    urls.push(url);
    throw new TypeError("down");
  };
}

const okFetch: FetchLike = async () => jsonResponse(200, completionJson());

// ------------------------------------------------------- explain scoring

describe("explain(): score + breakdown", () => {
  test("balanced attaches composite score with per-term contributions", async () => {
    const engine = new RoutingEngine(
      parseConfig({
        strategy: "balanced",
        routes: [...twoRoutes()],
        weights: { cost: 5, speed: 3, reliability: 2 },
      }),
      {
        fetchImpl: okFetch,
        sleep: noopSleep,
        pricing: { a: { input: 10, output: 10 }, b: { input: 1, output: 1 } },
      },
    );
    const decision = await engine.explain(req);
    const sel = decision.selected!;
    expect(sel.score).toBeDefined();
    expect(sel.scoreBreakdown).toBeDefined();
    expect(sel.routeId).toBe("b");
    expect(sel.scoreBreakdown!.cost).toBeGreaterThan(sel.scoreBreakdown!.reliability);
    const backup = decision.candidates.find((c) => c.routeId === "a")!;
    expect(backup.score).toBeDefined();
    expect(backup.score!).toBeLessThan(sel.score!);
    expect(sel.reasons.some((r) => r.startsWith("score "))).toBe(true);
  });

  test("fallback strategy leaves scores unset", async () => {
    const engine = new RoutingEngine(parseConfig({ routes: [...twoRoutes()] }), {
      fetchImpl: okFetch,
      sleep: noopSleep,
    });
    const decision = await engine.explain(req);
    expect(decision.selected?.score).toBeUndefined();
    expect(decision.selected?.scoreBreakdown).toBeUndefined();
  });
});

// -------------------------------------------------- actual-cost feedback

describe("actual-cost ratio feedback", () => {
  test("systematically underestimated route loses its cheapest crown", async () => {
    const priceyA: FetchLike = async (url) =>
      jsonResponse(
        200,
        url.includes("api.openai.com")
          ? completionJson({ usage: { prompt_tokens: 10, completion_tokens: 5_000, total_tokens: 5_010 } })
          : completionJson(),
      );
    const base = {
      sleep: noopSleep,
      pricing: { a: { input: 1, output: 1 }, b: { input: 1, output: 1 } },
    };

    // No history: tie on estimates -> config order (a).
    const naive = new RoutingEngine(parseConfig({ strategy: "cheapest", routes: [...twoRoutes()] }), {
      fetchImpl: okFetch,
      ...base,
    });
    expect((await naive.explain(req)).selected?.routeId).toBe("a");

    // Real usage on a reveals a big underestimate -> corrected estimate flips.
    const engine = new RoutingEngine(parseConfig({ strategy: "cheapest", routes: [...twoRoutes()] }), {
      fetchImpl: priceyA,
      ...base,
    });
    await engine.complete(req);
    expect((await engine.explain(req)).selected?.routeId).toBe("b");
    const snap = (await engine.stats()).health.find((h) => h.routeId === "a")!;
    expect(snap.costRatio).toBeGreaterThan(1);
  });
});

// ------------------------------------------------------ configurable weights

describe("configurable policy weights", () => {
  test("parse validates weights strictly", () => {
    expect(() => parseConfig({ routes: [...twoRoutes()], weights: { cost: 1 } })).not.toThrow();
    expect(() => parseConfig({ routes: [...twoRoutes()], weights: { cost: -1 } })).toThrow(/positive/);
    expect(() => parseConfig({ routes: [...twoRoutes()], weights: { nope: 1 } })).toThrow(/unknown field/);
    expect(() => parseConfig({ routes: [...twoRoutes()], weights: {} })).toThrow(/at least one/);
  });

  test("speed-dominant weights outrank cost for slow-cheap vs fast-pricey", async () => {
    const withWeights = (weights: Record<string, number>) =>
      new RoutingEngine(parseConfig({ strategy: "balanced", routes: [...twoRoutes()], weights }), {
        fetchImpl: okFetch,
        sleep: noopSleep,
        pricing: { a: { input: 1, output: 1 }, b: { input: 50, output: 50 } },
        decay: { halfLifeMs: 0, sampleTtlMs: 0 },
      });

    // Identical observations; only the weight mix changes the verdict.
    const seed = (e: RoutingEngine): void => {
      e.health.recordSuccess("a", { latencyMs: 300 }); // slow + cheap
      e.health.recordSuccess("b", { latencyMs: 1 }); // fast + pricey
    };
    const speedFirst = withWeights({ cost: 1, speed: 9, reliability: 1 });
    seed(speedFirst);
    expect((await speedFirst.explain(req)).selected?.routeId).toBe("b");

    const costFirst = withWeights({ cost: 9, speed: 1, reliability: 1 });
    seed(costFirst);
    expect((await costFirst.explain(req)).selected?.routeId).toBe("a");
  });
});

// --------------------------------------------- quality evaluators/autoTask

describe("quality evaluators + autoTask", () => {
  test("evaluator scores feed outcome memory automatically", async () => {
    const qualityByProvider: Record<string, number> = { openai: 1, b: 0 };
    const engine = new RoutingEngine(
      parseConfig({ strategy: "quality-first", routes: [...twoRoutes()] }),
      {
        fetchImpl: okFetch,
        sleep: noopSleep,
        evaluators: [
          {
            name: "test",
            evaluate: (ctx) => qualityByProvider[ctx.response.provider] ?? 0.5,
          },
        ],
      },
    );
    await engine.complete(req); // served by a ("openai") -> quality 1
    await engine.complete({ ...req, model: "b" }); // served by b -> quality 0
    const stats = await engine.stats();
    const chatBucket = stats.outcomes.filter((o) => o.task === "");
    expect(chatBucket.length).toBe(2);
    expect(chatBucket.find((o) => o.routeId === "a")!.avgQuality).toBe(1);
    expect(chatBucket.find((o) => o.routeId === "b")!.avgQuality).toBe(0);
  });

  test("evaluator failures and abstentions are swallowed", async () => {
    const engine = new RoutingEngine(parseConfig({ routes: [...twoRoutes()] }), {
      fetchImpl: okFetch,
      sleep: noopSleep,
      evaluators: [{ name: "boom", evaluate: () => { throw new Error("nope"); } }],
    });
    const res = await engine.complete(req);
    expect(res.provider).toBe("openai");
  });

  test("inferTask buckets by request shape", () => {
    expect(inferTask({ ...req, tools: [{ type: "function", function: { name: "x", parameters: {} } }] }, 10)).toBe("tool-use");
    expect(inferTask(req, 10)).toBe("chat");
    expect(inferTask(req, 90_000)).toBe("long-context");
    expect(inferTask({ ...req, response_format: { type: "json_object" } }, 10)).toBe("structured");
  });

  test("autoTask isolates quality memory per workload shape", async () => {
    const urls: string[] = [];
    const engine = new RoutingEngine(
      parseConfig({ strategy: "quality-first", routes: [...twoRoutes()] }),
      { fetchImpl: urlsFetch(urls), sleep: noopSleep, autoTask: true },
    );
    const toolsReq: ChatRequest = {
      ...req,
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    };
    // Untasked bucket stays empty; tool-use bucket says b >> a.
    for (let i = 0; i < 15; i++) {
      engine.recordOutcome({ routeId: "a", task: "tool-use", success: false, quality: 0 });
      engine.recordOutcome({ routeId: "b", task: "tool-use", success: true, quality: 1 });
    }
    await engine.complete(toolsReq).catch(() => {});
    expect(urls[0]).toContain("b.test");
  });
});

// ---------------------------------------------------------- state store

class FakeKV {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string, _ttl?: number): void {
    this.map.set(key, value);
  }
}

describe("learned-state persistence", () => {
  test("flush + hydrate round-trips health and circuit state", async () => {
    const kv = new FakeKV();
    const cfg = parseConfig({ routes: [...twoRoutes()] });

    const engineA = new RoutingEngine(cfg, {
      // a fails (CB opens after 1 failure); b succeeds.
      fetchImpl: async (url) =>
        url.includes("api.openai.com") ? jsonResponse(500, {}) : jsonResponse(200, completionJson()),
      sleep: noopSleep,
      stateStore: kv,
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });
    await engineA.complete(req).catch(() => {}); // a fails -> CB opens; b serves
    await engineA.flushState();

    const engineB = new RoutingEngine(cfg, {
      fetchImpl: okFetch,
      sleep: noopSleep,
      stateStore: kv,
    });
    await engineB.ready();
    const statsB = await engineB.stats();
    expect(statsB.health.find((h) => h.routeId === "a")?.failures).toBeGreaterThan(0);
    expect(statsB.circuitBreakers.find((c) => c.routeId === "a")?.open).toBe(true);

    // Hydrated breaker skips a without fetching.
    const urls: string[] = [];
    const engineC = new RoutingEngine(parseConfig({ routes: [...twoRoutes()] }), {
      fetchImpl: urlsFetch(urls),
      sleep: noopSleep,
      stateStore: kv,
    });
    await engineC.ready();
    await engineC.complete(req).catch(() => {});
    expect(urls[0]).toContain("b.test");
  });

  test("corrupt snapshot starts fresh, never throws", async () => {
    const kv = new FakeKV();
    kv.set("ai-router:state:v1", "{not json");
    const engine = new RoutingEngine(parseConfig({ routes: [...twoRoutes()] }), {
      fetchImpl: okFetch,
      sleep: noopSleep,
      stateStore: kv,
    });
    await engine.ready();
    const res = await engine.complete(req);
    expect(res.provider).toBe("openai");
  });

  test("outcome memory round-trips through flush/hydrate", async () => {
    const kv = new FakeKV();
    const cfg = parseConfig({ strategy: "quality-first", routes: [...twoRoutes()] });
    const engineA = new RoutingEngine(cfg, {
      fetchImpl: okFetch,
      sleep: noopSleep,
      stateStore: kv,
    });
    for (let i = 0; i < 12; i++) {
      engineA.recordOutcome({ routeId: "b", task: "summarize", success: true, quality: 1 });
    }
    await engineA.flushState();

    const urls: string[] = [];
    const engineB = new RoutingEngine(cfg, {
      fetchImpl: urlsFetch(urls),
      sleep: noopSleep,
      stateStore: kv,
    });
    await engineB.ready();
    await engineB.complete(req, { routing: { task: "summarize" } }).catch(() => {});
    expect(urls[0]).toContain("b.test"); // learned preference survived restart
  });
});

// -------------------------------------------------------------- replay

describe("offline replay harness", () => {
  const routes = [...twoRoutes()];
  const events = [
    { request: { model: "a", messages: [{ role: "user", content: "hi" }] }, servedRouteId: "a", success: true, latencyMs: 400 },
    { request: { model: "a", messages: [{ role: "user", content: "hi" }] }, servedRouteId: "b", success: true, latencyMs: 100 },
    { request: { model: "a", messages: [{ role: "user", content: "hi" }] }, servedRouteId: "b", success: true, latencyMs: 110 },
    { request: { model: "a", messages: [{ role: "user", content: "hi" }] }, servedRouteId: "b", success: true, latencyMs: 90 },
  ];

  test("least-latency flips to the faster provider mid-log", () => {
    const result = replayStrategy({ routes }, "least-latency", events);
    expect(result.chosen[0]).toBe("a"); // cold start: config order
    expect(result.chosen[2]).toBe("b"); // learned: b is faster
    expect(result.chosen[3]).toBe("b");
  });

  test("quality-first learns from recorded app outcomes", () => {
    const qEvents = events.map((e) => ({
      request: e.request,
      servedRouteId: e.servedRouteId,
      success: true as const,
      latencyMs: undefined,
      quality: e.servedRouteId === "b" ? 1 : 0,
    }));
    const result = replayStrategy({ routes }, "quality-first", qEvents);
    expect(result.chosen[2]).toBe("b");
  });

  test("deterministic across replays with seeded rng", () => {
    const r1 = replayStrategy({ routes }, "round-robin", events, { rng: () => 0.5 });
    const r2 = replayStrategy({ routes }, "round-robin", events, { rng: () => 0.5 });
    expect(r1.orders).toEqual(r2.orders);
    expect(r1.chosen).toEqual(["a", "b", "a", "b"]); // rotation visible
  });
});

// ------------------------------------------------------- tracker units

describe("tracker units", () => {
  test("OutcomeTracker custom alpha converges fast", () => {
    const o = new OutcomeTracker({ alpha: 0.99 });
    for (let i = 0; i < 5; i++) o.record({ routeId: "r", quality: 0 });
    o.record({ routeId: "r", quality: 1 });
    expect(o.snapshot()[0]!.avgQuality!).toBeGreaterThan(0.95);
  });

  test("balancedScores respects weight normalization", () => {
    const scores = balancedScores({
      estCosts: [1, 2],
      latencies: [undefined, undefined],
      successScores: [undefined, undefined],
      weights: { cost: 10, speed: 0, reliability: 0 },
    });
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
  });
});
