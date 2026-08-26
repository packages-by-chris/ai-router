import { describe, expect, test, vi } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import type { ChatRequest } from "../src/types.js";
import { HealthTracker, wilsonLowerBound } from "../src/routing/health.js";
import { shrinkLatencies } from "../src/routing/order.js";
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

// ---------------------------------------------------------------- decay

describe("staleness: decay + sample expiry", () => {
  test("success evidence decays toward neutral after silence", () => {
    const h = new HealthTracker({ halfLifeMs: 1_000 });
    for (let i = 0; i < 10; i++) h.recordSuccess("r");
    expect(h.snapshot()[0]!.successRate).toBeGreaterThan(0.95);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 16_000); // ~4 half-lives
      const stale = h.snapshot()[0]!;
      expect(stale.successRate).toBeLessThan(0.6);
      expect(stale.successRate).toBeGreaterThan(0.45);
    } finally {
      vi.useRealTimers();
    }
  });

  test("latency samples expire", () => {
    const h = new HealthTracker({ sampleTtlMs: 1_000 });
    h.recordSuccess("r", { latencyMs: 100 });
    expect(h.medianLatency("r")).toBe(100);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 2_000);
      expect(h.medianLatency("r")).toBeUndefined();
      expect(h.sampleCount("r")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("least-latency forgets stale winners (config order returns)", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const fetch: FetchLike = async (url) => {
        calls.push(url);
        return jsonResponse(200, completionJson());
      };
      const engine = new RoutingEngine(
        parseConfig({ strategy: "least-latency", routes: [...twoRoutes()] }),
        { fetchImpl: fetch, sleep: noopSleep },
      );
      await engine.complete(req); // a observed
      vi.setSystemTime(Date.now() + 50);
      await engine.complete({ ...req, model: "b" }); // b explored
      expect(calls[1]).toContain("b.test");

      // Samples age out -> unobserved again -> config order (a first).
      vi.setSystemTime(Date.now() + 20 * 60_000);
      calls.length = 0;
      await engine.complete(req);
      expect(calls[0]).toContain("api.openai.com");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------- per-op statistics

describe("per-op latency separation", () => {
  test("stream TTFB does not pollute complete percentiles and vice versa", () => {
    const h = new HealthTracker();
    h.recordSuccess("r", { op: "complete", latencyMs: 500 });
    h.recordSuccess("r", { op: "stream", ttfbMs: 20 });
    const snap = h.snapshot()[0]!;
    expect(snap.complete?.p50Ms).toBe(500);
    expect(snap.stream?.p50Ms).toBeUndefined();
    expect(snap.stream?.ttfb?.p50Ms).toBe(20);
    // Blended legacy views still exist.
    expect(snap.p50LatencyMs).toBe(500);
    expect(snap.p50TtfbMs).toBe(20);
  });

  test("least-latency ranks completes by complete stats, streams by TTFB", async () => {
    const mk = () =>
      new RoutingEngine(parseConfig({ strategy: "least-latency", routes: [...twoRoutes()] }), {
        fetchImpl: okFetch,
        sleep: noopSleep,
      });
    const completeView = mk();
    completeView.health.recordSuccess("a", { op: "complete", latencyMs: 400 });
    completeView.health.recordSuccess("b", { op: "complete", latencyMs: 100 });
    expect((await completeView.explain(req)).candidates[0]!.routeId).toBe("b");

    // Stream view: only a has fresh stream samples; b's fast COMPLETE time
    // must not leak into stream ordering.
    const streamView = mk();
    streamView.health.recordSuccess("a", { op: "stream", ttfbMs: 30 });
    streamView.health.recordSuccess("b", { op: "complete", latencyMs: 10 });
    expect((await streamView.explain(req)).candidates[0]!.routeId).toBe("a");
  });
});

// ------------------------------------------------- failure-aware latency

describe("failure latency is kind-gated", () => {
  test("timeouts count as slow evidence; fast 500s do not make broken routes look fast", () => {
    const h = new HealthTracker();
    h.recordFailure("slow-dead", "timeout", { latencyMs: 5_000 });
    h.recordFailure("fast-500", "server", { latencyMs: 5 });
    expect(h.medianLatency("slow-dead")).toBe(5_000);
    expect(h.medianLatency("fast-500")).toBeUndefined();
  });

  test("engine records elapsed time of failed attempts (timeout kind)", async () => {
    const engine = new RoutingEngine(
      parseConfig({ routes: [...twoRoutes()] }),
      {
        fetchImpl: async () => jsonResponse(500, {}), // server kind, fast
        sleep: noopSleep,
      },
    );
    await engine.complete(req).catch(() => {});
    const snap = (await engine.stats()).health.find((h) => h.routeId === "a")!;
    expect(snap.failures).toBeGreaterThan(0);
    // server-kind failures carry no speed evidence.
    expect(snap.p50LatencyMs).toBeUndefined();
  });
});

// --------------------------------------------------------- statistical rigor

describe("statistical rigor", () => {
  test("wilsonLowerBound punishes small samples", () => {
    expect(wilsonLowerBound(3, 3)!).toBeLessThan(wilsonLowerBound(12, 13)!);
    expect(wilsonLowerBound(0, 0)).toBeUndefined();
  });

  test("balanced prefers proven reliability over lucky streaks", async () => {
    const engine = new RoutingEngine(
      parseConfig({ strategy: "balanced", routes: [...twoRoutes()] }),
      {
        fetchImpl: okFetch,
        sleep: noopSleep,
        pricing: { a: { input: 1, output: 1 }, b: { input: 1, output: 1 } },
      },
    );
    for (let i = 0; i < 3; i++) engine.health.recordSuccess("a");
    for (let i = 0; i < 13; i++) engine.health.recordSuccess("b");
    engine.health.recordFailure("b", "server");
    expect((await engine.explain(req)).selected?.routeId).toBe("b");
  });

  test("shrinkLatencies neutralizes single-sample outliers", () => {
    const shrunk = shrinkLatencies([10, 500], [1, 9]);
    expect(shrunk[0]!).toBeGreaterThan(100); // lone 10ms pulled toward anchor
    expect(shrunk[1]).toBe(500); // well-sampled untouched
  });

  test("timeout-heavy route loses its reliability edge under balanced", async () => {
    const engine = new RoutingEngine(
      parseConfig({ strategy: "balanced", routes: [...twoRoutes()] }),
      {
        fetchImpl: okFetch,
        sleep: noopSleep,
        pricing: { a: { input: 1, output: 1 }, b: { input: 1, output: 1 } },
      },
    );
    for (let i = 0; i < 8; i++) engine.health.recordFailure("a", i % 2 === 0 ? "timeout" : "server");
    for (let i = 0; i < 8; i++) engine.health.recordFailure("b", "server");
    for (let i = 0; i < 8; i++) engine.health.recordSuccess("a");
    for (let i = 0; i < 8; i++) engine.health.recordSuccess("b");
    expect((await engine.explain(req)).selected?.routeId).toBe("b");
  });
});

// ------------------------------------------------------------ exploration

describe("exploration (opt-in)", () => {
  test("disabled by default: deterministic ordering", async () => {
    const calls: string[] = [];
    const countingOk: FetchLike = async (url) => {
      calls.push(url);
      return jsonResponse(200, completionJson());
    };
    const engine = new RoutingEngine(
      parseConfig({ strategy: "cheapest", routes: [...twoRoutes()] }),
      {
        fetchImpl: countingOk,
        sleep: noopSleep,
        pricing: { a: { input: 1, output: 1 }, b: { input: 9, output: 9 } },
      },
    );
    for (let i = 0; i < 5; i++) await engine.complete(req);
    // Every request's FIRST call hits the cheap primary — no forced probes.
    for (let i = 0; i < 5; i++) expect(calls[i]).toContain("api.openai.com");
  });

  test("interval forces a loser probe every Nth request", async () => {
    const urls: string[] = [];
    const engine = new RoutingEngine(
      parseConfig({ strategy: "cheapest", routes: [...twoRoutes()] }),
      {
        fetchImpl: urlsFetch(urls),
        sleep: noopSleep,
        rng: () => 0.99,
        explore: { interval: 2 },
        pricing: { a: { input: 1, output: 1 }, b: { input: 9, output: 9 } },
      },
    );
    for (let i = 0; i < 4; i++) await engine.complete(req).catch(() => {});
    expect(urls.filter((u) => u.includes("b.test")).length).toBeGreaterThanOrEqual(2);
  });

  test("epsilon path promotes via rng draw + logs the swap", async () => {
    const urls: string[] = [];
    const logs: unknown[] = [];
    const engine = new RoutingEngine(
      parseConfig({ strategy: "cheapest", routes: [...twoRoutes()] }),
      {
        fetchImpl: urlsFetch(urls),
        sleep: noopSleep,
        rng: () => 0.0,
        explore: { epsilon: 0.5 },
        pricing: { a: { input: 1, output: 1 }, b: { input: 9, output: 9 } },
      },
    );
    await engine.complete(req, { onLog: (l) => logs.push(l) }).catch(() => {});
    expect(urls[0]).toContain("b.test");
    const explore = logs.find((l) => (l as { type: string }).type === "explore") as
      | { promotedRouteId: string; replacedRouteId: string }
      | undefined;
    expect(explore).toMatchObject({ promotedRouteId: "b", replacedRouteId: "a" });
  });

  test("explain() never draws rng for exploration (no side effects)", async () => {
    let draws = 0;
    const engine = new RoutingEngine(
      parseConfig({ strategy: "cheapest", routes: [...twoRoutes()] }),
      {
        fetchImpl: urlsFetch([]),
        sleep: noopSleep,
        rng: () => {
          draws++;
          return 0.0;
        },
        explore: { epsilon: 0.5 },
        pricing: { a: { input: 9, output: 9 }, b: { input: 1, output: 1 } },
      },
    );
    await engine.explain(req);
    expect(draws).toBe(0);
  });
});
