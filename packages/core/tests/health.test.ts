import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import { HealthTracker } from "../src/routing/health.js";
import { OutcomeTracker } from "../src/routing/outcomes.js";
import { simulate, healthy, rateLimited, sequence } from "./simulator.js";

const noopSleep = async () => {};

const cfg = (routes: Array<Record<string, unknown>>) =>
  parseConfig({
    routes: [
      {
        id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1",
        model: "a-model", apiKey: "ka", maxRetries: 0, ...routes[0],
      },
      {
        id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1",
        model: "b-model", apiKey: "kb", maxRetries: 0, ...routes[1],
      },
    ],
  });

const req = { model: "a", messages: [{ role: "user" as const, content: "hi" }] };

describe("HealthTracker unit", () => {
  test("percentiles from recorded samples", () => {
    const h = new HealthTracker();
    for (let i = 1; i <= 100; i++) h.recordSuccess("r", { latencyMs: i });
    const snap = h.snapshot().find((x) => x.routeId === "r")!;
    expect(snap.successes).toBe(100);
    expect(snap.p50LatencyMs).toBe(50);
    expect(snap.p95LatencyMs).toBe(95);
    expect(snap.p99LatencyMs).toBe(99);
  });

  test("failure tallies by kind and success EMA movement", () => {
    const h = new HealthTracker();
    h.recordFailure("r", "rate_limit");
    h.recordFailure("r", "server");
    h.recordFailure("r", "server");
    let snap = h.snapshot()[0]!;
    expect(snap.failures).toBe(3);
    expect(snap.byKind).toMatchObject({ rate_limit: 1, server: 2 });
    expect(snap.successRate).toBeLessThan(1);
    for (let i = 0; i < 20; i++) h.recordSuccess("r");
    snap = h.snapshot()[0]!;
    expect(snap.successRate).toBeGreaterThan(0.9);
  });

  test("key cooldowns set by retry-after and expire naturally", async () => {
    const h = new HealthTracker();
    h.recordFailure("r", "rate_limit", { keyIndex: 0, retryAfterMs: 30 });
    expect(h.keyOnCooldown("r", 0)).toBe(true);
    expect(h.pickKey("r", 0, 2)).toBe(1); // skips cooling key 0
    await new Promise((r) => setTimeout(r, 35));
    expect(h.keyOnCooldown("r", 0)).toBe(false);
    expect(h.pickKey("r", 0, 2)).toBe(0);
  });

  test("cooldown caps at KEY_COOLDOWN_CAP_MS", () => {
    const h = new HealthTracker();
    h.recordFailure("r", "rate_limit", { keyIndex: 0, retryAfterMs: 999_999_999 });
    const snap = h.snapshot()[0]!;
    expect(snap.keys[0]!.cooldownRemainingMs).toBeLessThanOrEqual(5 * 60_000);
  });

  test("pickKey returns null only when ALL keys are cooling", () => {
    const h = new HealthTracker();
    h.recordFailure("r", "auth", { keyIndex: 0, retryAfterMs: 60_000 });
    h.recordFailure("r", "auth", { keyIndex: 1, retryAfterMs: 60_000 });
    expect(h.pickKey("r", 0, 2)).toBeNull();
  });

  test("ttft percentiles tracked separately from total latency", () => {
    const h = new HealthTracker();
    h.recordSuccess("s", { ttfbMs: 10 });
    const snap = h.snapshot()[0]!;
    expect(snap.p50TtfbMs).toBe(10);
    expect(snap.p50LatencyMs).toBeUndefined();
  });
});

describe("engine-integrated health", () => {
  test("successes/failures land in stats().health with latencies", async () => {
    const sim = simulate({ a: healthy() });
    const engine = new RoutingEngine(cfg([{}]), { fetchImpl: sim.fetch, sleep: noopSleep });
    await engine.complete(req);
    const snap = (await engine.stats()).health.find((h) => h.routeId === "a")!;
    expect(snap.successes).toBe(1);
    expect(snap.failures).toBe(0);
    expect(snap.p50LatencyMs).toBeDefined();
  });

  test("429 Retry-After cools the burned key; later calls skip straight to the healthy key", async () => {
    // Two-key pool on route a.
    const twoKeyCfg = parseConfig({
      routes: [{
        id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1",
        model: "a-model", apiKeys: ["ka1", "ka2"], maxRetries: 0,
      }],
    });
    const sim = simulate({
      a: sequence(rateLimited(60), healthy(), healthy()),
    });
    const engine = new RoutingEngine(twoKeyCfg, { fetchImpl: sim.fetch, sleep: noopSleep });

    // Call 1: ka1 gets 429 (+Retry-After) -> rotate -> ka2 serves.
    await engine.complete(req);
    expect(sim.countByHost("a")).toBe(2);
    expect(sim.calls[0]!.init?.headers).toMatchObject({ authorization: "Bearer ka1" });
    expect(sim.calls[1]!.init?.headers).toMatchObject({ authorization: "Bearer ka2" });

    // Call 2: cursor starts on ka2 (healthy) and serves; cursor wraps to ka1.
    await engine.complete(req);

    // Call 3: cursor lands on cooling ka1 -> engine logs the skip and goes
    // straight to ka2 (no wasted call with ka1).
    const before = sim.countByHost("a");
    const logs: unknown[] = [];
    await engine.complete(req, { onLog: (l) => logs.push(l) });
    expect(sim.countByHost("a")).toBe(before + 1); // exactly one a-call
    expect(sim.calls.at(-1)!.init?.headers).toMatchObject({ authorization: "Bearer ka2" });
    const skip = logs.find((l) => (l as { type: string }).type === "key_skip") as
      | { skipped: number; keyIndex: number }
      | undefined;
    expect(skip).toMatchObject({ skipped: 1, keyIndex: 1 });
  });

  test("stream failures record TTFT-based health, not total latency", async () => {
    const encoder = new TextEncoder();
    const sse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: "1",
              choices: [{ delta: { content: "hi" }, finish_reason: null }],
            })}\n\n`));
            c.enqueue(encoder.encode("data: [DONE]\n\n"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const sim = simulate({ a: sse });
    const engine = new RoutingEngine(cfg([{}]), { fetchImpl: sim.fetch, sleep: noopSleep });
    const stream = await engine.stream(req);
    for await (const c of stream) void c;
    const snap = (await engine.stats()).health.find((h) => h.routeId === "a")!;
    expect(snap.p50TtfbMs).toBeDefined();
    expect(snap.successes).toBe(1);
  });
});

describe("OutcomeTracker unit", () => {
  test("EMA math converges toward recent samples", () => {
    const o = new OutcomeTracker();
    for (let i = 0; i < 10; i++) o.record({ routeId: "r", quality: 0 });
    o.record({ routeId: "r", quality: 1 }); // one hot sample
    const stat = o.snapshot().find((s) => s.routeId === "r")!;
    expect(stat.avgQuality).toBeGreaterThan(0);
    expect(stat.avgQuality!).toBeLessThan(0.31); // alpha 0.3
  });

  test("task buckets are independent", () => {
    const o = new OutcomeTracker();
    o.record({ routeId: "r", task: "t1", quality: 1 });
    const t1 = o.snapshot().find((s) => s.task === "t1")!;
    const none = o.snapshot().find((s) => s.task === "")!;
    expect(t1.avgQuality).toBe(1);
    expect(none).toBeUndefined();
  });
});
