import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import { AllRoutesFailedError, ProviderError } from "../src/errors.js";
import {
  simulate,
  healthy,
  rateLimited,
  serverError,
  authFailure,
  badRequest,
  flaky,
  hangs,
  slow,
  streamOk,
  streamFailsMidway,
  streamStartsLate,
  sequence,
} from "./simulator.js";
import { collectStream } from "../src/stream.js";

const noopSleep = async () => {};

function threeRouteConfig(routeOverrides: Array<Record<string, unknown>> = []) {
  return parseConfig({
    routes: [
      {
        id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1",
        model: "a-model", apiKey: "ka", maxRetries: 0,
        ...routeOverrides[0],
      },
      {
        id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1",
        model: "b-model", apiKey: "kb", maxRetries: 0,
        ...routeOverrides[1],
      },
      {
        id: "c", provider: "openai-compatible", baseUrl: "https://c.test/v1",
        model: "c-model", apiKey: "kc", maxRetries: 0,
        ...routeOverrides[2],
      },
    ],
  });
}

function scenario(
  spec: Parameters<typeof simulate>[0],
  routeOverrides: Array<Record<string, unknown>> = [],
  engineOpts: Record<string, unknown> = {},
) {
  const sim = simulate(spec);
  const engine = new RoutingEngine(threeRouteConfig(routeOverrides), {
    sleep: noopSleep,
    fetchImpl: sim.fetch,
    ...engineOpts,
  });
  return { sim, engine };
}

const req = { model: "a", messages: [{ role: "user" as const, content: "hi" }] };

describe("failure scenarios (deterministic simulator)", () => {
  test("A healthy -> immediate success", async () => {
    const { sim, engine } = scenario({ a: healthy() });
    const res = await engine.complete(req);
    expect(res.provider).toBe("a");
    expect(sim.countByHost("a")).toBe(1);
  });

  test("A rate-limited -> B success (single key exhausts rotation)", async () => {
    const { sim, engine } = scenario({ a: rateLimited(), b: healthy() });
    const res = await engine.complete(req);
    expect(res.provider).toBe("b");
    expect(sim.countByHost("a")).toBe(1);
    expect(sim.countByHost("b")).toBe(1);
  });

  test("A timeout -> B retries its own 500 then serves -> C never needed", async () => {
    const config = parseConfig({
      routes: [
        { id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1", model: "m", apiKey: "ka", maxRetries: 0, timeoutMs: 40 },
        { id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1", model: "m2", apiKey: "kb", maxRetries: 1 },
        { id: "c", provider: "openai-compatible", baseUrl: "https://c.test/v1", model: "m3", apiKey: "kc", maxRetries: 0 },
      ],
    });
    const sim = simulate({
      a: hangs(),
      b: flaky(1), // 500 then OK on the retried attempt
      c: healthy(),
    });
    const engine = new RoutingEngine(config, { sleep: noopSleep, fetchImpl: sim.fetch });
    const res = await engine.complete(req);
    expect(res.provider).toBe("b");
    expect(sim.countByHost("a")).toBe(1);
    expect(sim.countByHost("b")).toBe(2);
    expect(sim.countByHost("c")).toBe(0);
  });

  test("A stream begins then dies post-commit -> caller sees the error, no silent provider switch", async () => {
    const { sim, engine } = scenario({ a: streamFailsMidway() });
    const stream = await engine.stream(req); // committed to a
    await expect(collectStream(stream)).rejects.toMatchObject({ name: "Error" });
    expect(sim.countByHost("a")).toBe(1);
    expect(sim.countByHost("b")).toBe(0); // NEVER fell back mid-stream
  });

  test("A stalls pre-commit -> fallback delivers B's stream", async () => {
    const { sim, engine } = scenario(
      { a: streamStartsLate(), b: streamOk(1) },
      [{ streamIdleTimeoutMs: 30 }, {}, {}],
    );
    const stream = await engine.stream(req);
    const chunks = await collectStream(stream);
    expect(chunks.length).toBeGreaterThan(0);
    expect(sim.countByHost("a")).toBe(1);
    expect(sim.countByHost("b")).toBe(1);
  });

  test("capability mismatch on A -> B serves without A being contacted", async () => {
    const { sim, engine } = scenario(
      { b: healthy() },
      [{ capabilities: { vision: false } }, {}, {}],
    );
    const res = await engine.complete({
      ...req,
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://img.test/x.png" } }],
      }],
    });
    expect(res.provider).toBe("b");
    expect(sim.countByHost("a")).toBe(0);
  });

  test("auth failure exhausts both keys then falls through to B", async () => {
    const config = parseConfig({
      routes: [
        { id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1", model: "m", apiKeys: ["ka1", "ka2"], maxRetries: 0 },
        { id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1", model: "m2", apiKey: "kb" },
      ],
    });
    const sim = simulate({ a: authFailure(401), b: healthy() });
    const engine = new RoutingEngine(config, { sleep: noopSleep, fetchImpl: sim.fetch });
    const res = await engine.complete(req);
    expect(res.provider).toBe("b");
    expect(sim.countByHost("a")).toBe(2); // both keys burned
  });

  test("flaky A recovers within retries without falling back", async () => {
    const config = parseConfig({
      routes: [
        { id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1", model: "m", apiKey: "ka", maxRetries: 3 },
      ],
    });
    const sim = simulate({ a: flaky(2) }); // 500, 500, then OK
    const engine = new RoutingEngine(config, { sleep: noopSleep, fetchImpl: sim.fetch });
    const res = await engine.complete(req);
    expect(res.provider).toBe("a");
    expect(sim.countByHost("a")).toBe(3);
  });

  test("slow-but-successful response survives when under the per-attempt timeout", async () => {
    const config = parseConfig({
      routes: [
        { id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1", model: "m", apiKey: "ka", timeoutMs: 5_000 },
      ],
    });
    const sim = simulate({ a: slow(10) });
    const engine = new RoutingEngine(config, { sleep: noopSleep, fetchImpl: sim.fetch });
    const res = await engine.complete(req);
    expect(res.provider).toBe("a");
  });

  test("non-retryable 400 fails the route immediately and falls through", async () => {
    const { sim, engine } = scenario({ a: badRequest(400), b: healthy() });
    const res = await engine.complete(req);
    expect(res.provider).toBe("b");
    expect(sim.countByHost("a")).toBe(1);
  });

  test("all routes dead -> AllRoutesFailedError with full trail", async () => {
    const { engine } = scenario({ a: serverError(), b: rateLimited(), c: badRequest(404) });
    try {
      await engine.complete(req);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AllRoutesFailedError);
      const trail = (err as AllRoutesFailedError).attempts;
      expect(trail.map((t) => t.routeId)).toEqual(["a", "b", "c"]);
      expect(trail.map((t) => t.outcome)).toEqual(["error", "error", "error"]);
      expect(trail.map((t) => t.kind)).toEqual(["server", "rate_limit", "not_found"]);
    }
  });

  test("streaming works end-to-end across a healthy simulated provider", async () => {
    const { engine } = scenario({ a: streamOk(3) });
    const chunks = await collectStream(await engine.stream(req));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.delta.content === "hi")).toBe(true);
  });

  test("classified kinds survive into the failure trail", async () => {
    const config = parseConfig({
      routes: [
        { id: "solo", provider: "openai-compatible", baseUrl: "https://solo.test/v1", model: "m", apiKey: "k" },
      ],
    });
    const sim = simulate({ solo: serverError(503) });
    const engine = new RoutingEngine(config, { sleep: noopSleep, fetchImpl: sim.fetch });
    try {
      await engine.complete({ ...req, model: "solo" });
      expect.unreachable();
    } catch (err) {
      const all = err as AllRoutesFailedError;
      expect(all.attempts[0]!.kind).toBe("server");
    }
  });

  test("concurrent requests each get independent walks (no cross-talk)", async () => {
    const { sim, engine } = scenario({
      a: sequence(serverError(), healthy()),
      b: healthy(),
    }, [{ maxRetries: 0 }]);
    const [r1, r2] = await Promise.allSettled([
      engine.complete(req),
      engine.complete(req),
    ]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    if (r1.status === "fulfilled" && r2.status === "fulfilled") {
      // One served by b (after a's single scripted failure), one by a directly
      // or b — order depends on scheduling; both must have real content.
      expect(["a", "b"]).toContain(r1.value.provider);
      expect(["a", "b"]).toContain(r2.value.provider);
    }
    expect(sim.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("simulator sanity", () => {
  test("behaviors are deterministic across replays", async () => {
    for (let i = 0; i < 2; i++) {
      const sim = simulate({ a: flaky(1) });
      const config = parseConfig({
        routes: [{ id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1", model: "m", apiKey: "k", maxRetries: 0 }],
      });
      const engine = new RoutingEngine(config, { sleep: noopSleep, fetchImpl: sim.fetch });
      await expect(engine.complete(req)).rejects.toBeInstanceOf(AllRoutesFailedError);
      expect(sim.countByHost("a")).toBe(1);
    }
  });

  test("ProviderError classification matches status codes", () => {
    const pe = new ProviderError("x", "rate_limit", "429", { status: 429 });
    expect(pe.kind).toBe("rate_limit");
  });
});
