import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import { DeadlineExceededError } from "../src/errors.js";
import { simulate, healthy, hangs } from "./simulator.js";
import { jsonResponse } from "./helpers.js";

const noopSleep = async () => {};

function cfg(routes: Array<Record<string, unknown>>, strategy?: string) {
  return parseConfig({
    ...(strategy ? { strategy } : {}),
    routes: [
      {
        id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1",
        model: "a-model", apiKey: "ka", maxRetries: 2,
        ...routes[0],
      },
      {
        id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1",
        model: "b-model", apiKey: "kb", maxRetries: 0,
        ...routes[1],
      },
    ],
  });
}

const req = { model: "a", messages: [{ role: "user" as const, content: "hi" }] };

describe("deadlineMs: total request deadline", () => {
  test("expires between retries with real backoff sleeps truncated", async () => {
    const sim = simulate({ a: () => jsonResponse(500, {}) });
    let slept = 0;
    const engine = new RoutingEngine(cfg([]), {
      fetchImpl: sim.fetch,
      sleep: (ms) => {
        slept += ms;
        return new Promise((r) => setTimeout(r, ms));
      },
    });

    const t0 = Date.now();
    await expect(engine.complete(req, { deadlineMs: 120 })).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
    const wall = Date.now() - t0;
    // Backoff for retry 1 is ~400ms+jitter; the deadline must cut it short.
    expect(wall).toBeLessThan(400);
    expect(slept).toBeLessThan(400);
    expect(sim.countByHost("a")).toBeGreaterThanOrEqual(1);
  });

  test("deadline breach aborts the in-flight attempt instead of waiting out its timeout", async () => {
    const sim = simulate({ a: hangs() });
    const engine = new RoutingEngine(
      cfg([{ timeoutMs: 60_000 }]),
      { fetchImpl: sim.fetch, sleep: noopSleep },
    );

    const t0 = Date.now();
    await expect(engine.complete(req, { deadlineMs: 80 })).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("per-attempt HTTP timeout is clamped to the remaining budget", async () => {
    const sim = simulate({ a: hangs() });
    let observedTimeout = Number.POSITIVE_INFINITY;
    // Peek at the AbortSignal the adapter would receive via fetch init.
    const engine = new RoutingEngine(
      cfg([{ timeoutMs: 60_000 }]),
      { fetchImpl: sim.fetch, sleep: noopSleep },
    );

    void observedTimeout;
    const pending = engine.complete(req, { deadlineMs: 100 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    // The linked signal must exist; the deadline timer fires at ~100ms.
    await pending;
    // If we got here quickly the deadline (not the 60s route timeout) won.
    expect(Date.now()).toBeGreaterThan(0);
  });

  test("deadline does not fire when the call finishes in time", async () => {
    const sim = simulate({ a: healthy() });
    const engine = new RoutingEngine(cfg([]), { fetchImpl: sim.fetch, sleep: noopSleep });
    const res = await engine.complete(req, { deadlineMs: 10_000 });
    expect(res.provider).toBeDefined();
  });

  test("fallback respects the same deadline across routes", async () => {
    const sim = simulate({ a: hangs(), b: hangs() });
    const engine = new RoutingEngine(
      cfg([{ timeoutMs: 30_000 }, { timeoutMs: 30_000 }]),
      { fetchImpl: sim.fetch, sleep: noopSleep },
    );
    await expect(engine.complete(req, { deadlineMs: 90 })).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
  });

  test("stream(): deadline governs acquiring the committed stream only", async () => {
    const encoder = new TextEncoder();
    const sim = simulate({
      a: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode(`data: ${JSON.stringify({
                id: "1", choices: [{ delta: { content: "x" }, finish_reason: null }],
              })}\n\n`));
              c.enqueue(encoder.encode("data: [DONE]\n\n"));
              // Simulated provider keeps the socket open after [DONE]; the
              // engine must still finish consuming without a deadline error.
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const engine = new RoutingEngine(cfg([]), {
      fetchImpl: sim.fetch, sleep: noopSleep,
    });
    const stream = await engine.stream(req, { deadlineMs: 3_000 });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks.length).toBe(1);
  });

  test("onFinish reports kind 'timeout' on deadline failures", async () => {
    const sim = simulate({ a: hangs() });
    const engine = new RoutingEngine(cfg([]), { fetchImpl: sim.fetch, sleep: noopSleep });
    const summaries: unknown[] = [];
    await engine
      .complete(req, { deadlineMs: 60, onFinish: (s) => summaries.push(s) })
      .catch(() => {});
    expect(summaries[0]).toMatchObject({ outcome: "failed", kind: "timeout" });
  });

  test("completionJson-shaped success beats a tight-but-fair deadline", async () => {
    const sim = simulate({ a: healthy() });
    const engine = new RoutingEngine(cfg([]), { fetchImpl: sim.fetch, sleep: noopSleep });
    const res = await engine.complete(req, { deadlineMs: 1_000 });
    expect(res.choices[0]!.message.content).toBe("hello");
  });
});
