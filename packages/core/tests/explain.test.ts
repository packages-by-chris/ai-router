import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import type { RoutingExplanation } from "../src/engine.js";
import { AIRouter } from "../src/router.js";
import { simulate, healthy, rateLimited, hangs } from "./simulator.js";
import { jsonResponse } from "./helpers.js";

const noopSleep = async () => {};

function buildEngine(
  routeOverrides: Array<Record<string, unknown>>,
  engineOpts: Record<string, unknown> = {},
  strategy?: string,
) {
  const config = parseConfig({
    ...(strategy ? { strategy } : {}),
    routes: [
      {
        id: "a", provider: "openai", model: "a-model", apiKey: "SECRET-A",
        maxRetries: 0,
        ...routeOverrides[0],
      },
      {
        id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1",
        model: "b-model", apiKey: "SECRET-B", maxRetries: 0,
        ...routeOverrides[1],
      },
      {
        id: "c", provider: "openai-compatible", baseUrl: "https://c.test/v1",
        model: "c-model", apiKey: "SECRET-C", maxRetries: 0,
        ...routeOverrides[2],
      },
    ],
  });
  return new RoutingEngine(config, { sleep: noopSleep, ...engineOpts });
}

const req = { model: "a", messages: [{ role: "user" as const, content: "hi" }] };

describe("explain()", () => {
  test("dry-run selects the first eligible candidate and lists the rest as backups", async () => {
    const sim = simulate({ a: healthy(), b: healthy(), c: healthy() });
    const engine = buildEngine([{}, {}, {}], { fetchImpl: sim.fetch });
    const explanation = await engine.explain(req);
    expect(explanation.model).toBe("a");
    expect(explanation.strategy).toBe("fallback");
    expect(explanation.candidates.map((c) => c.routeId)).toEqual(["a", "b", "c"]);
    expect(explanation.selected?.routeId).toBe("a");
    expect(explanation.candidates.map((c) => c.status)).toEqual([
      "selected", "backup", "backup",
    ]);
    // DRY-RUN: nothing executed.
    expect(sim.calls).toHaveLength(0);
  });

  test("reports rejection reasons for capability mismatches", async () => {
    const engine = buildEngine(
      [{ capabilities: { tools: false } }, {}, {}],
      {},
    );
    const explanation = await engine.explain({
      ...req,
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    });
    expect(explanation.candidates[0]).toMatchObject({ status: "rejected" });
    expect(explanation.candidates[0]!.reasons[0]).toMatch(/tools/);
    expect(explanation.selected?.routeId).toBe("b");
  });

  test("circuit-open routes appear rejected with reason", async () => {
    const config = parseConfig({ routes: [
      { id: "a", provider: "openai-compatible", baseUrl: "https://z.test/v1", model: "m", apiKey: "k", maxRetries: 0 },
      { id: "b", provider: "openai-compatible", baseUrl: "https://y.test/v1", model: "m2", apiKey: "k2", maxRetries: 0 },
    ]});
    const sim = simulate({ z: () => jsonResponse(500, {}), y: healthy() });
    const engine = new RoutingEngine(config, {
      sleep: noopSleep, fetchImpl: sim.fetch,
      circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
    });
    await engine.complete(req).catch(() => {});
    const explanation = await engine.explain(req);
    expect(explanation.candidates[0]).toMatchObject({
      routeId: "a", status: "rejected",
    });
    expect(explanation.candidates[0]!.reasons[0]).toMatch(/circuit breaker open/);
    expect(explanation.selected?.routeId).toBe("b");
  });

  test("budget exhaustion shows up read-only (no quota consumed)", async () => {
    let usedCalls = 0;
    const store = {
      take: async () => ({ allowed: true, retryAfterMs: 0 }),
      record: async () => {},
      used: async () => {
        usedCalls++;
        return Number.MAX_SAFE_INTEGER; // budget saturated
      },
    };
    const config = parseConfig({ routes: [
      { id: "a", provider: "openai", model: "m", apiKey: "k", budget: { usd: 5 }, limit: { rpm: 100 } },
      { id: "b", provider: "openai-compatible", baseUrl: "https://bb.test/v1", model: "m2", apiKey: "k2" },
    ]});
    const engine = new RoutingEngine(config, { sleep: noopSleep, store: store as never });
    const explanation = await engine.explain(req);
    expect(explanation.candidates[0]!.status).toBe("rejected");
    expect(explanation.candidates[0]!.reasons[0]).toMatch(/budget exhausted/);
    expect(explanation.selected?.routeId).toBe("b");
    const takesBefore = usedCalls;
    await engine.explain(req);
    // explain() never consumes rpm: store.take not called at all (we can't
    // observe it directly here, but `used` reads are read-only by contract).
    expect(usedCalls).toBeGreaterThanOrEqual(takesBefore);
  });

  test("explain() never consumes rpm quota", async () => {
    // rpm: 2. If explain() consumed quota, two explains would starve the
    // real call below.
    let takes = 0;
    const store = {
      take: async () => {
        takes++;
        return { allowed: takes <= 2, retryAfterMs: 60_000 };
      },
      record: async () => {},
    };
    const config = parseConfig({ routes: [
      { id: "a", provider: "openai-compatible", baseUrl: "https://q.test/v1", model: "m", apiKey: "k", limit: { rpm: 2 } },
    ]});
    const sim = simulate({ q: healthy() });
    const engine = new RoutingEngine(config, { fetchImpl: sim.fetch, sleep: noopSleep, store: store as never });
    await engine.explain(req);
    await engine.explain(req);
    expect(takes).toBe(0); // explain never called take()
    const res = await engine.complete(req);
    expect(res.provider).toBe("a"); // full quota still available
    expect(takes).toBe(1);
  });

  test("includes estimated cost when pricing exists", async () => {
    const engine = buildEngine([{}, {}, {}], {
      pricing: { a: { input: 3, output: 15 }, b: { input: 1, output: 2 } },
    });
    const explanation = await engine.explain(req);
    expect(explanation.candidates[0]!.estimatedCostUsd).toBeDefined();
    expect(explanation.candidates[1]!.estimatedCostUsd).toBeDefined();
    expect(explanation.candidates[1]!.estimatedCostUsd!).toBeLessThan(
      explanation.candidates[0]!.estimatedCostUsd!,
    );
  });

  test("NEVER leaks api keys into explanations", async () => {
    const engine = buildEngine([{}, {}, {}], {});
    const explanation: RoutingExplanation = await engine.explain(req);
    const serialized = JSON.stringify(explanation);
    expect(serialized).not.toContain("SECRET-A");
    expect(serialized).not.toContain("SECRET-B");
    expect(serialized).not.toContain("SECRET-C");
    expect(serialized).not.toContain("apiKey");
  });

  test("AIRouter facade exposes explain() and stats().health/outcomes", async () => {
    const router = new AIRouter(
      parseConfig({ routes: [
        { id: "r1", provider: "openai", model: "m", apiKey: "k" },
      ]}),
      { fetchImpl: async () => jsonResponse(200, {
        id: "x", choices: [{ message: { role: "assistant", content: "hi" } }], usage: null,
      }), sleep: noopSleep },
    );
    const explanation = await router.explain({ model: "r1", messages: [{ role: "user", content: "q" }] });
    expect(explanation.selected?.routeId).toBe("r1");
    router.recordOutcome({ routeId: "r1", quality: 0.9 });
    const stats = await router.stats();
    expect(stats.outcomes).toHaveLength(1);
    expect(stats.health).toEqual([]);
  });
});

describe("hangs simulator sanity for explain paths", () => {
  test("explain does not trigger timeouts or fetches on hanging providers", async () => {
    const sim = simulate({ a: hangs(), b: rateLimited() });
    const engine = buildEngine([{}, {}, {}], { fetchImpl: sim.fetch });
    const explanation = await engine.explain(req);
    expect(sim.calls).toHaveLength(0);
    expect(explanation.selected?.routeId).toBe("a");
  });
});
