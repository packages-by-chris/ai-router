import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import type { AttemptEvent, CallSummaryEvent, LogEvent } from "../src/engine.js";
import { AIRouter } from "../src/router.js";
import { simulate, healthy, rateLimited, serverError, authFailure, sequence } from "./simulator.js";
import { chunkJson, sseResponse } from "./helpers.js";

const noopSleep = async () => {};

const KEY = "sk-super-secret-key-DO-NOT-LEAK";

function securedConfig() {
  return parseConfig({
    routes: [
      {
        id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1",
        model: "a-model", apiKey: KEY, maxRetries: 0,
        headers: { "x-custom": "h1" },
      },
      {
        id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1",
        model: "b-model", apiKey: `${KEY}-b`, maxRetries: 0,
      },
    ],
  });
}

const req = { model: "a", messages: [{ role: "user" as const, content: "hi" }] };

describe("credential leakage prevention", () => {
  test("ProviderError messages and bodies never contain the api key", async () => {
    const sim = simulate({ a: serverError(500) });
    const engine = new RoutingEngine(securedConfig(), {
      fetchImpl: sim.fetch, sleep: noopSleep,
    });
    try {
      await engine.complete(req);
      expect.unreachable();
    } catch (err) {
      const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err as object));
      // JSON.stringify(Error) is lossy; check message + body explicitly.
      const anyErr = err as { message?: string; body?: unknown; attempts?: unknown };
      expect(String(anyErr.message ?? "")).not.toContain(KEY);
      expect(JSON.stringify(anyErr.body ?? {})).not.toContain(KEY);
      expect(JSON.stringify(anyErr.attempts ?? [])).not.toContain(KEY);
      void serialized;
    }
  });

  test("AllRoutesFailedError trail carries kinds/messages only — never keys", async () => {
    const sim = simulate({ a: rateLimited(), b: serverError() });
    const engine = new RoutingEngine(securedConfig(), {
      fetchImpl: sim.fetch, sleep: noopSleep,
    });
    try {
      await engine.complete(req);
      expect.unreachable();
    } catch (err) {
      expect(JSON.stringify((err as { attempts: unknown }).attempts)).not.toContain(KEY);
    }
  });

  test("onAttempt / onLog / onFinish payloads are key-free", async () => {
    const sim = simulate({
      a: sequence(serverError(), healthy()),
      b: healthy(),
    });
    const engine = new RoutingEngine(securedConfig(), {
      fetchImpl: sim.fetch, sleep: noopSleep,
    });
    const events: AttemptEvent[] = [];
    const logs: LogEvent[] = [];
    const summaries: CallSummaryEvent[] = [];
    await engine.complete(req, {
      onAttempt: (e) => events.push(e),
      onLog: (l) => logs.push(l),
      onFinish: (s) => summaries.push(s),
    });
    const dump = JSON.stringify({ events, logs, summaries });
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("authorization");
  });

  test("explain() output contains no credentials or headers", async () => {
    const sim = simulate({ a: healthy(), b: healthy() });
    const engine = new RoutingEngine(securedConfig(), { fetchImpl: sim.fetch, sleep: noopSleep });
    const explanation = await engine.explain(req);
    const dump = JSON.stringify(explanation);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("x-custom");
    expect(dump).not.toContain("h1");
  });

  test("stats() exposes cursors and health but no keys", async () => {
    const sim = simulate({ a: healthy(), b: healthy() });
    const engine = new RoutingEngine(securedConfig(), { fetchImpl: sim.fetch, sleep: noopSleep });
    await engine.complete(req);
    const stats = await engine.stats();
    const dump = JSON.stringify(stats);
    expect(dump).not.toContain(KEY);
  });

  test("streaming chunks carry provider labels, not credentials", async () => {
    const sim = simulate({
      a: async () =>
        sseResponse([chunkJson(), `data: ${JSON.stringify({
          id: "x", model: "a-model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}`]),
    });
    const engine = new RoutingEngine(securedConfig(), { fetchImpl: sim.fetch, sleep: noopSleep });
    const stream = await engine.stream(req);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(JSON.stringify(chunks)).not.toContain(KEY);
  });

  test("AIRouter facade end-to-end keeps keys out of every surface", async () => {
    const sim = simulate({ a: authFailure(403), b: healthy() });
    const router = new AIRouter(securedConfig(), { fetchImpl: sim.fetch, sleep: noopSleep });
    const events: unknown[] = [];
    const res = await router.complete(req, { onAttempt: (e) => events.push(e) });
    expect(res.provider).toBe("b");
    expect(JSON.stringify(events)).not.toContain(KEY);
    const stats = await router.stats();
    expect(JSON.stringify(stats)).not.toContain(KEY);
    const explanation = await router.explain(req);
    expect(JSON.stringify(explanation)).not.toContain(KEY);
  });

  test("route views handed to filters expose id/provider/model/capabilities only", async () => {
    const sim = simulate({ a: healthy() });
    const engine = new RoutingEngine(securedConfig(), { fetchImpl: sim.fetch, sleep: noopSleep });
    let viewKeys: string[] = [];
    await engine.complete(req, {
      routing: {
        filter: (route) => {
          viewKeys = Object.keys(route);
          return true;
        },
      },
    });
    expect(viewKeys.sort()).toEqual(["id", "model", "provider"]);
  });
});
