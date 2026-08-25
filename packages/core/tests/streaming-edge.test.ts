import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import type { ChatChunk } from "../src/types.js";
import { chunkJson, completionJson, jsonResponse } from "./helpers.js";

const noopSleep = async () => {};

interface RecordedCall {
  host: string;
  init?: RequestInit;
}

function setup(
  spec: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
  routes: Array<Record<string, unknown>> = [],
  opts: Record<string, unknown> = {},
) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const host = new URL(url).hostname.replace(/\.(test|local)$/, "");
    const behavior = spec[host];
    calls.push({ host, init });
    if (!behavior) throw new Error(`no behavior for ${host}`);
    await new Promise((r) => setTimeout(r, 0));
    return behavior(init);
  };
  const config = parseConfig({
    routes: [
      {
        id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1",
        model: "a-model", apiKey: "ka", maxRetries: 0,
        ...routes[0],
      },
      {
        id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1",
        model: "b-model", apiKey: "kb", maxRetries: 0,
        ...routes[1],
      },
    ],
  });
  return { calls, engine: new RoutingEngine(config, { sleep: noopSleep, fetchImpl, ...opts }) };
}

const req = { model: "a", messages: [{ role: "user" as const, content: "hi" }] };

function sse(events: string[], closeAfter = true): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(encoder.encode(e));
        if (closeAfter) c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("streaming edge cases", () => {
  test("empty stream yields a single commit sentinel and does not fall back", async () => {
    const { calls, engine } = setup({ a: () => sse([]) });
    const stream = await engine.stream(req);
    const chunks: ChatChunk[] = [];
    for await (const c of stream) chunks.push(c);
    // One synthetic empty chunk marks the committed-but-empty stream; the
    // route is final either way.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe("");
    expect(calls).toHaveLength(1);
  });

  test("usage-only trailing chunk is surfaced with usage and cost when priced", async () => {
    const events = [
      `data: ${chunkJson()}\n\n`,
      `data: ${JSON.stringify({
        id: "x",
        model: "a-model",
        choices: [],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const { engine } = setup({ a: () => sse(events) }, [], {
      pricing: { a: { input: 2, output: 4 } },
    });
    const chunks = [];
    for await (const c of await engine.stream(req)) chunks.push(c);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.usage?.total_tokens).toBe(1_000_000);
    expect(chunks[1]!.cost_usd).toBe(2); // input only
  });

  test("caller breaking early stops iteration cleanly without erroring", async () => {
    // Many chunks; consumer stops after the first. The engine must release
    // its attempt resources (abort listener + timers) and never throw.
    const many = Array.from({ length: 50 }, (_, i) =>
      `data: ${chunkJson({ id: String(i) })}\n\n`);
    const { engine } = setup({ a: () => sse(many) });
    const stream = await engine.stream(req);
    let seen = 0;
    for await (const c of stream) {
      void c;
      seen++;
      if (seen === 1) break;
    }
    expect(seen).toBe(1);
    // The generator must now be finished — iterating again yields nothing.
    for await (const c of stream) void c;
  });

  test("caller abort mid-stream arms the upstream request signal", async () => {
    // With real fetch, aborting this signal tears down the HTTP body. In the
    // mock world we assert the plumbing: the signal handed to fetchImpl must
    // be aborted when the caller aborts mid-iteration.
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    // Simulate what a real HTTP stack does: aborting the request signal
    // errors the in-flight body stream.
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const infinite = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          upstream = c;
          const enc = new TextEncoder();
          c.enqueue(enc.encode(`data: ${chunkJson()}\n\n`));
          c.enqueue(enc.encode(`data: ${chunkJson({ id: "2" })}\n\n`));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const config = parseConfig({
      routes: [{
        id: "a", provider: "openai-compatible", baseUrl: "https://a.test/v1",
        model: "a-model", apiKey: "ka", maxRetries: 0,
      }],
    });
    const captureFetch = async (_url: string, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      fetchSignal = signal;
      signal?.addEventListener(
        "abort",
        () => upstream?.error(signal.reason ?? new DOMException("aborted", "AbortError")),
        { once: true },
      );
      await new Promise((r) => setTimeout(r, 0));
      return infinite;
    };
    const engine = new RoutingEngine(config, { sleep: noopSleep, fetchImpl: captureFetch });

    const stream = await engine.stream(req, { signal: controller.signal });
    const received: string[] = [];
    try {
      for await (const c of stream) {
        received.push(c.id);
        if (received.length === 2) controller.abort();
      }
    } catch {
      // aborted mid-iteration -> fine
    }
    expect(fetchSignal?.aborted).toBe(true);
  });

  test("mid-stream in-band error objects surface as ProviderErrors after commit", async () => {
    // OpenRouter-style in-band error object followed by stream end.
    const events = [
      `data: ${chunkJson()}\n\n`,
      `data: ${JSON.stringify({ error: { message: "overloaded mid-stream" } })}\n\n`,
    ];
    const { engine } = setup({ a: () => sse(events) });
    const stream = await engine.stream(req);
    await expect(async () => {
      for await (const c of stream) void c;
    }).rejects.toMatchObject({ kind: "server", provider: "a" });
  });

  test("[DONE] before any content yields the commit sentinel", async () => {
    const { engine } = setup({ a: () => sse(["data: [DONE]\n\n"]) });
    const stream = await engine.stream(req);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe("");
  });

  test("malformed JSON lines are tolerated as keep-alive noise", async () => {
    const events = [
      ": ping\n\n", // comment frame
      "data: not-json\n\n",
      `data: ${chunkJson()}\n\n`,
      "data: [DONE]\n\n",
    ];
    const { engine } = setup({ a: () => sse(events) });
    const chunks = [];
    for await (const c of await engine.stream(req)) chunks.push(c);
    expect(chunks).toHaveLength(1);
  });

  test("pre-commit HTTP failure still falls back to route b", async () => {
    const { calls, engine } = setup(
      {
        a: () => jsonResponse(502, {}),
        b: () => sse([`data: ${chunkJson()}\n\n`, "data: [DONE]\n\n"]),
      },
      [{}, {}],
    );
    const chunks = [];
    for await (const c of await engine.stream(req)) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(calls.map((c) => c.host)).toEqual(["a", "b"]);
  });

  test("complete() responses unaffected by streaming machinery", async () => {
    const { engine } = setup({ a: async () => jsonResponse(200, completionJson()) });
    const res = await engine.complete(req);
    expect(res.choices[0]!.message.content).toBe("hello");
  });
});
