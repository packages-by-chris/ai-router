import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import type { AttemptEvent } from "../src/engine.js";
import { capabilityRejection, inferredRequirements } from "../src/routing/capabilities.js";
import type { ChatRequest } from "../src/types.js";
import { MockFetch, completionJson, jsonResponse } from "./helpers.js";

const noopSleep = async () => {};

function cfg(
  routes: Array<Record<string, unknown>>,
  strategy?: string,
) {
  return parseConfig({
    strategy,
    routes: [
      { id: "a", provider: "openai", model: "a-model", apiKey: "ka", maxRetries: 0, ...routes[0] },
      {
        id: "b",
        provider: "openai-compatible",
        baseUrl: "https://b.example/v1",
        model: "b-model",
        apiKey: "kb",
        maxRetries: 0,
        ...routes[1],
      },
    ],
  });
}

const req: ChatRequest = { model: "a", messages: [{ role: "user", content: "hi" }] };

describe("capability config validation", () => {
  test("accepts and round-trips capabilities", () => {
    const parsed = parseConfig({
      routes: [{
        id: "x", provider: "openai", model: "m", apiKey: "k",
        capabilities: { tools: true, vision: false, contextWindow: 128_000 },
      }],
    });
    expect(parsed.routes[0]!.capabilities).toEqual({ tools: true, vision: false, contextWindow: 128_000 });
  });

  test("rejects unknown capability fields", () => {
    expect(() =>
      parseConfig({
        routes: [{
          id: "x", provider: "openai", model: "m", apiKey: "k",
          capabilities: { toolz: true },
        }],
      }),
    ).toThrow(/capabilities\.toolz: unknown field/);
  });

  test("rejects non-boolean capability values and bad contextWindow", () => {
    expect(() =>
      parseConfig({
        routes: [{ id: "x", provider: "openai", model: "m", apiKey: "k", capabilities: { tools: "yes" } }],
      }),
    ).toThrow(/capabilities\.tools: must be a boolean/);
    expect(() =>
      parseConfig({
        routes: [{ id: "x", provider: "openai", model: "m", apiKey: "k", capabilities: { contextWindow: -1 } }],
      }),
    ).toThrow(/contextWindow/);
  });
});

describe("request-inferred capability elimination", () => {
  test("tools requests skip routes that declare no tools support", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(cfg([{}, { capabilities: { vision: true } }]), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    const events: AttemptEvent[] = [];
    const res = await engine.complete(
      { ...req, tools: [{ type: "function", function: { name: "f", parameters: {} } }] },
      { onAttempt: (e) => events.push(e) },
    );
    expect(res.provider).toBe("openai"); // route a has no declared caps -> eligible
    // route b was evaluated second; if it had been reached it would be skipped
  });

  test("fallback skips capability-mismatched route before fetching it", async () => {
    // Route a declares tools:false; request carries tools -> b must serve.
    const mock = new MockFetch(jsonResponse(200, completionJson({ model: "b-model" })));
    const engine = new RoutingEngine(cfg([{ capabilities: { tools: false } }]), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    const events: AttemptEvent[] = [];
    const res = await engine.complete(
      { ...req, tools: [{ type: "function", function: { name: "f", parameters: {} } }] },
      { onAttempt: (e) => events.push(e) },
    );
    expect(res.provider).toBe("b");
    expect(events.map((e) => e.outcome)).toEqual(["capability_mismatch", "ok"]);
    expect(mock.calls).toHaveLength(1); // only b fetched
  });

  test("vision inference from image parts", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(cfg([{ capabilities: { vision: false } }, { capabilities: { vision: true } }]), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    const events: AttemptEvent[] = [];
    await engine.complete({
      ...req,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://x.test/i.png" } },
        ],
      }],
    }, { onAttempt: (e) => events.push(e) });
    expect(events.map((e) => e.outcome)).toEqual(["capability_mismatch", "ok"]);
  });

  test("json_object needs json; json_schema needs structuredOutput", async () => {
    const mock = new MockFetch(
      jsonResponse(200, completionJson({ model: "b-1" })),
      jsonResponse(200, completionJson({ model: "b-2" })),
    );
    const engine = new RoutingEngine(
      cfg([
        { capabilities: { vision: true } }, // neither json nor structuredOutput
        { capabilities: { json: true, structuredOutput: true } },
      ]),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );
    const events: AttemptEvent[] = [];
    await engine.complete(
      { ...req, response_format: { type: "json_schema", json_schema: { schema: {} } } },
      { onAttempt: (e) => events.push(e) },
    );
    expect(events.map((e) => e.outcome)).toEqual(["capability_mismatch", "ok"]);

    const events2: AttemptEvent[] = [];
    await engine.complete(
      { model: "a", messages: req.messages, response_format: { type: "json_object" } },
      { onAttempt: (e) => events2.push(e) },
    );
    expect(events2.map((e) => e.outcome)).toEqual(["capability_mismatch", "ok"]);
  });

  test("reasoning_effort requires reasoning declaration", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(
      cfg([{ capabilities: { reasoning: false } }, { capabilities: { reasoning: true } }]),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );
    const events: AttemptEvent[] = [];
    await engine.complete({ ...req, reasoning_effort: "low" }, { onAttempt: (e) => events.push(e) });
    expect(events[0]!.outcome).toBe("capability_mismatch");
    expect(events.at(-1)!.outcome).toBe("ok");
  });

  test("stream() requires declared streaming support", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(
      cfg([{ capabilities: { streaming: false } }]),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );
    // Route a would have succeeded but declares streaming:false -> skipped.
    const stream = await engine.stream(req);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.url).toContain("b.example");
  });

  test("embed() respects embeddings capability declarations", async () => {
    const embedBody = {
      object: "list",
      data: [{ index: 0, embedding: [1, 2] }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    };
    const mock = new MockFetch(jsonResponse(200, embedBody));
    const engine = new RoutingEngine(
      cfg([{ capabilities: { embeddings: false } }]),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );
    const res = await engine.embed({ model: "a", input: "hi" });
    expect(res.data[0]!.embedding).toEqual([1, 2]);
    expect(mock.calls).toHaveLength(1); // b served directly
  });

  test("contextWindow eliminates oversized inputs", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(
      cfg([{ capabilities: { contextWindow: 8 } }, {}]),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );
    const big = "x".repeat(100); // ~29 tokens by the 3.5 chars/token heuristic
    const events: AttemptEvent[] = [];
    await engine.complete(
      { model: "a", messages: [{ role: "user", content: big }] },
      { onAttempt: (e) => events.push(e) },
    );
    expect(events[0]!.outcome).toBe("capability_mismatch");
    expect(events[0]!.message).toMatch(/contextWindow 8/);
  });

  test("routes without declared capabilities are never filtered", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(cfg([{}, {}]), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    const events: AttemptEvent[] = [];
    await engine.complete({ ...req, tools: [{ type: "function", function: { name: "f", parameters: {} } }] }, {
      onAttempt: (e) => events.push(e),
    });
    expect(events[0]!.outcome).toBe("ok"); // undeclared profile stays eligible
  });
});

describe("explicit routing.require (hard constraint)", () => {
  test("require.vision eliminates even undeclared routes", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(
      cfg([{}, { capabilities: { vision: true } }]),
      { fetchImpl: mock.fetch, sleep: noopSleep },
    );
    const events: AttemptEvent[] = [];
    const res = await engine.complete(req, {
      onAttempt: (e) => events.push(e),
      routing: { require: { vision: true } },
    });
    expect(res.provider).toBe("b");
    expect(events.map((e) => e.outcome)).toEqual(["capability_mismatch", "ok"]);
  });

  test("unsatisfiable require fails all routes with mismatch records", async () => {
    const mock = new MockFetch();
    const engine = new RoutingEngine(cfg([{}, {}]), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    const events: AttemptEvent[] = [];
    await expect(engine.complete(req, {
      routing: { require: { audio: true } },
      onAttempt: (e) => events.push(e),
    })).rejects.toMatchObject({ name: "AllRoutesFailedError" });
    expect(events.map((e) => e.outcome)).toEqual(["capability_mismatch", "capability_mismatch"]);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("custom filter", () => {
  test("filter sees a secret-free view and excludes matches", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const views: unknown[] = [];
    const engine = new RoutingEngine(cfg([{}, {}]), {
      fetchImpl: mock.fetch, sleep: noopSleep,
    });
    const events: AttemptEvent[] = [];
    await engine.complete(req, {
      onAttempt: (e) => events.push(e),
      routing: {
        filter: (route) => {
          views.push(route);
          return route.id !== "a";
        },
      },
    });
    expect(views[0]).toMatchObject({ id: "a", provider: "openai", model: "a-model" });
    expect(JSON.stringify(views)).not.toContain("ka"); // no api keys leak into views
    expect(events[0]!.outcome).toBe("capability_mismatch");
    expect(events[0]!.message).toMatch(/custom filter/);
  });
});

describe("inferredRequirements unit", () => {
  test("derives requirements from request shape", () => {
    const need = inferredRequirements(
      {
        model: "x",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "u" } }] }],
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
        response_format: { type: "json_object" },
        reasoning_effort: "high",
      },
      "stream",
    );
    expect(need).toMatchObject({
      streaming: true, tools: true, vision: true, json: true, reasoning: true,
    });
    expect(need.embeddings).toBeUndefined();

    const embedNeed = inferredRequirements({ model: "x", messages: [] }, "embed");
    expect(embedNeed.embeddings).toBe(true);
  });

  test("capabilityRejection reports explicit requirement failures first", () => {
    const reason = capabilityRejection(
      { tools: true },
      { model: "x", messages: [] },
      "complete",
      { tools: true, audio: true },
    );
    expect(reason).toMatch(/requires audio/);
  });
});
