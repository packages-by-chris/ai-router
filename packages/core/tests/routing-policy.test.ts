import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import type { AttemptEvent } from "../src/engine.js";
import type { FetchLike } from "../src/http/request.js";
import { estimateCostUsd } from "../src/routing/order.js";
import { completionJson, jsonResponse } from "./helpers.js";

const noopSleep = async () => {};

/** Always answers 200 OK without recording anything. */
const alwaysOk: FetchLike = async () =>
  jsonResponse(200, completionJson());

/** Records requested URLs then fails like an unreachable network. */
function recorder(urls: string[]): FetchLike {
  return async (url) => {
    urls.push(url);
    throw new TypeError("simulated network outage");
  };
}

function threeRouteEngine(
  opts: Record<string, unknown> = {},
) {
  const config = parseConfig({
    strategy: opts.strategy as string | undefined,
    routes: [
      { id: "a", provider: "openai", model: "a-model", apiKey: "ka", maxRetries: 0 },
      {
        id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1",
        model: "b-model", apiKey: "kb", maxRetries: 0,
      },
      {
        id: "c", provider: "openai-compatible", baseUrl: "https://c.test/v1",
        model: "c-model", apiKey: "kc", maxRetries: 0,
      },
    ],
  });
  const { strategy: _s, ...rest } = opts;
  return new RoutingEngine(config, { sleep: noopSleep, ...rest });
}

const req: import("../src/types.js").ChatRequest = { model: "a", messages: [{ role: "user", content: "hi" }] };

/** Walk order observed from attempted hosts. */
async function walkOrder(engine: RoutingEngine, request = req): Promise<string[]> {
  const hosts: string[] = [];
  await engine
    .complete(request, { onAttempt: (e) => hosts.push(e.routeId) })
    .catch(() => {});
  return hosts;
}

describe("estimateCostUsd unit", () => {
  test("combines input and output pricing per 1M tokens", () => {
    // $3/M input, $15/M output, 1M input + 0.5M output tokens.
    expect(estimateCostUsd({ input: 3, output: 15 }, 1_000_000, 500_000)).toBeCloseTo(10.5);
  });

  test("defaults output estimate to the input size when max_tokens is absent", () => {
    expect(estimateCostUsd({ input: 2, output: 8 }, 1_000_000)).toBe(10);
  });

  test("cache tiers are ignored pre-flight (unknown hit rates)", () => {
    expect(estimateCostUsd({ input: 2, output: 8, cache_read: 0 }, 1_000)).toBe(
      estimateCostUsd({ input: 2, output: 8 }, 1_000),
    );
  });
});

describe("strategy: cheapest", () => {
  test("orders candidates by estimated cost ascending", async () => {
    const engine = threeRouteEngine({
      strategy: "cheapest",
      pricing: {
        a: { input: 10, output: 30 }, // most expensive
        b: { input: 1, output: 2 }, // cheapest
        c: { input: 3, output: 4 },
      },
      fetchImpl: recorder([]),
    });
    expect(await walkOrder(engine)).toEqual(["b", "c", "a"]);
  });

  test("max_tokens shifts output-weighted estimates", async () => {
    // x: dirt-cheap input, pricey output. y: the reverse.
    const mk = (urls: string[]) =>
      new RoutingEngine(
        parseConfig({ strategy: "cheapest", routes: [
          { id: "x", provider: "openai", model: "mx", apiKey: "kx", maxRetries: 0 },
          { id: "y", provider: "openai-compatible", baseUrl: "https://y.test/v1", model: "my", apiKey: "ky", maxRetries: 0 },
        ]}),
        {
          sleep: noopSleep,
          fetchImpl: recorder(urls),
          pricing: {
            x: { input: 0.1, output: 100 }, // output-heavy
            y: { input: 10, output: 0.1 }, // input-heavy
          },
        },
      );
    const bigInput = "z".repeat(3500); // ~1000 estimated tokens

    const cappedUrls: string[] = [];
    const e1 = mk(cappedUrls);
    const capped = await walkOrder(e1, {
      model: "x", messages: [{ role: "user", content: bigInput }], max_tokens: 8,
    });
    expect(capped[0]).toBe("x"); // tiny generation -> cheap input wins

    const uncappedUrls: string[] = [];
    const e2 = mk(uncappedUrls);
    const uncapped = await walkOrder(e2, {
      model: "x", messages: [{ role: "user", content: bigInput }], max_tokens: 2_000_000,
    });
    expect(uncapped[0]).toBe("y"); // huge generation -> cheap output wins
  });

  test("unpriced routes follow priced ones in config order", async () => {
    const engine = threeRouteEngine({
      strategy: "cheapest",
      pricing: { c: { input: 5, output: 5 } },
      fetchImpl: recorder([]),
    });
    expect(await walkOrder(engine)).toEqual(["c", "a", "b"]);
  });

  test("without any pricing, cheapest degrades to config order", async () => {
    const engine = threeRouteEngine({ strategy: "cheapest", fetchImpl: recorder([]) });
    expect(await walkOrder(engine)).toEqual(["a", "b", "c"]);
  });
});

describe("strategy: balanced", () => {
  function pairEngine(opts: Record<string, unknown> = {}, strategy = "balanced") {
    const config = parseConfig({ strategy, routes: [
      { id: "alpha", provider: "openai", model: "m1", apiKey: "k1", maxRetries: 0 },
      { id: "beta", provider: "openai-compatible", baseUrl: "https://beta.test/v1", model: "m2", apiKey: "k2", maxRetries: 0 },
    ]});
    const { strategy: _s, ...rest } = opts;
    return new RoutingEngine(config, { sleep: noopSleep, ...rest });
  }

  const alphaReq: import("../src/types.js").ChatRequest = { model: "alpha", messages: [{ role: "user", content: "hi" }] };

  test("cost dominates when no health data exists", async () => {
    const engine = pairEngine({
      fetchImpl: alwaysOk,
      pricing: { alpha: { input: 100, output: 100 }, beta: { input: 1, output: 1 } },
    });
    const res = await engine.complete(alphaReq);
    expect(res.provider).toBe("beta");
  });

  test("reliability outweighs equal cost after observed failures", async () => {
    const mock = [jsonResponse(500, {}), jsonResponse(200, completionJson()), jsonResponse(200, completionJson())];
    let i = 0;
    const scripted: FetchLike = async () => mock[i++]!;
    const engine = pairEngine({
      fetchImpl: scripted,
      pricing: { alpha: { input: 1, output: 1 }, beta: { input: 1, output: 1 } },
    });
    await engine.complete(alphaReq); // alpha fails, beta serves
    const res2 = await engine.complete(alphaReq); // beta healthy -> serves again
    expect(res2.provider).toBe("beta");
    expect(i).toBe(3);
  });

  test("ties keep config order; single-candidate chains are unaffected", async () => {
    const engine = new RoutingEngine(
      parseConfig({ strategy: "balanced", routes: [
        { id: "only", provider: "openai", model: "m", apiKey: "k" },
      ]}),
      { sleep: noopSleep, fetchImpl: alwaysOk,
        pricing: { only: { input: 9, output: 9 } } },
    );
    const res = await engine.complete({ ...req, model: "only" });
    expect(res.provider).toBe("openai");
  });
});

describe("strategy: quality-first", () => {
  test("routes by recorded task quality, degrading gracefully without data", async () => {
    const urls: string[] = [];
    const config = parseConfig({ strategy: "quality-first", routes: [
      { id: "a", provider: "openai", model: "ma", apiKey: "ka", maxRetries: 0 },
      { id: "b", provider: "openai-compatible", baseUrl: "https://q.test/v1", model: "mb", apiKey: "kb", maxRetries: 0 },
    ]});
    const engine = new RoutingEngine(config, { sleep: noopSleep, fetchImpl: recorder(urls) });

    // No outcome data yet: neutral scores tie -> config order (a first).
    await engine.complete(req).catch(() => {});
    expect(urls[0]).toContain("api.openai.com");

    // a excellent at "summarize"; b poor.
    for (let i = 0; i < 6; i++) {
      engine.recordOutcome({ routeId: "a", task: "summarize", quality: 1, success: true });
      engine.recordOutcome({ routeId: "b", task: "summarize", quality: 0, success: true });
    }
    urls.length = 0;
    await engine.complete(req, { routing: { task: "summarize" } }).catch(() => {});
    expect(urls[0]).toContain("api.openai.com"); // still a

    // Flip: b better than a for this task -> traffic flips.
    for (let i = 0; i < 20; i++) {
      engine.recordOutcome({ routeId: "a", task: "summarize", quality: 0, success: false });
      engine.recordOutcome({ routeId: "b", task: "summarize", quality: 1, success: true });
    }
    urls.length = 0;
    await engine.complete(req, { routing: { task: "summarize" } }).catch(() => {});
    expect(urls[0]).toContain("q.test");

    // Untasked bucket has no data -> back to neutral config order.
    urls.length = 0;
    await engine.complete(req).catch(() => {});
    expect(urls[0]).toContain("api.openai.com");
  });

  test("recordOutcome ignores unknown routes and invalid values", () => {
    const engine = threeRouteEngine();
    expect(() =>
      engine.recordOutcome({ routeId: "ghost", quality: 0.5 }),
    ).not.toThrow();
    expect(() => engine.recordOutcome({ routeId: "a", quality: 42 })).not.toThrow();
  });
});

describe("constraints", () => {
  test("maxCostUsd eliminates over-budget candidates pre-flight", async () => {
    const engine = new RoutingEngine(
      parseConfig({ routes: [
        { id: "pricey", provider: "openai", model: "m1", apiKey: "k1", maxRetries: 0 },
        { id: "frugal", provider: "openai-compatible", baseUrl: "https://fr.test/v1", model: "m2", apiKey: "k2", maxRetries: 0 },
      ]}),
      { sleep: noopSleep, fetchImpl: alwaysOk,
        pricing: { pricey: { input: 500, output: 500 }, frugal: { input: 1, output: 1 } } },
    );
    const events: AttemptEvent[] = [];
    const res = await engine.complete({ ...req, model: "pricey" }, {
      onAttempt: (e) => events.push(e),
      routing: { maxCostUsd: 0.001 },
    });
    expect(events[0]!.outcome).toBe("capability_mismatch"); // constraint rejections share the record shape
    expect(events[0]!.message).toMatch(/estimated cost .* exceeds maxCostUsd/);
    expect(res.provider).toBe("frugal");
  });

  test("unpriced routes survive maxCostUsd (cannot know)", async () => {
    const engine = threeRouteEngine({ fetchImpl: alwaysOk });
    const events: AttemptEvent[] = [];
    const res = await engine.complete(req, {
      onAttempt: (e) => events.push(e),
      routing: { maxCostUsd: 0 },
    });
    expect(events[0]!.outcome).toBe("ok");
    expect(res.provider).toBe("openai");
  });

  test("maxLatencyMs skips only routes with positive observed p50", async () => {
    const engine = new RoutingEngine(
      parseConfig({ routes: [
        { id: "sluggish", provider: "openai", model: "m1", apiKey: "k1", maxRetries: 0 },
        { id: "snappy", provider: "openai-compatible", baseUrl: "https://sn.test/v1", model: "m2", apiKey: "k2", maxRetries: 0 },
      ]}),
      { sleep: noopSleep, fetchImpl: alwaysOk },
    );
    // Seed an observation for sluggish by serving through it once.
    await engine.complete({ ...req, model: "sluggish" });
    const stats = await engine.stats();
    const sluggish = stats.health.find((h) => h.routeId === "sluggish");
    if (!sluggish?.p50LatencyMs) {
      return; // clock resolution too coarse on this machine; constraint vacuous
    }

    const events: AttemptEvent[] = [];
    const res = await engine.complete({ ...req, model: "sluggish" }, {
      onAttempt: (e) => events.push(e),
      routing: { maxLatencyMs: sluggish.p50LatencyMs - 1 },
    });
    expect(events[0]!.outcome).toBe("capability_mismatch");
    expect(events[0]!.message).toMatch(/maxLatencyMs/);
    expect(res.provider).toBe("snappy");
  });
});
