import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/errors.js";
import {
  OpenAIAdapter,
  translateChunk,
  translateRequest,
  translateResponse,
} from "../src/providers/openai.js";
import type { NormalizedRoute } from "../src/providers/types.js";
import type { ChatRequest } from "../src/types.js";
import { MockFetch, chunkJson, completionJson, jsonResponse, sseResponse } from "./helpers.js";

function route(overrides: Partial<NormalizedRoute> = {}): NormalizedRoute {
  return {
    id: "fast",
    provider: "openai",
    model: "gpt-4o-mini",
    keyPool: ["k1"],
    headers: {},
    maxRetries: 0,
    timeoutMs: 5_000,
    limits: {},
    ...overrides,
  };
}

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: "hi" }],
};

describe("translateRequest", () => {
  test("uses the provider model name, not the logical id", () => {
    const body = translateRequest(req, "gpt-4o-mini", false);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual(req.messages);
  });

  test("maps optional params and omits unset ones", () => {
    const body = translateRequest(
      { ...req, temperature: 0.5, max_tokens: 100, tools: undefined },
      "m",
      false,
    );
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
    expect(body.stream).toBeUndefined();
    expect("tools" in body).toBe(false);
  });

  test("stream mode requests usage-bearing chunks", () => {
    const body = translateRequest(req, "m", true);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("passes multimodal content arrays through natively", () => {
    const parts = [
      { type: "text" as const, text: "what is this?" },
      { type: "image_url" as const, image_url: { url: "https://ex.com/cat.jpg", detail: "low" as const } },
    ];
    const body = translateRequest({ model: "m", messages: [{ role: "user", content: parts }] }, "m", false);
    expect(body.messages).toEqual([{ role: "user", content: parts }]);
  });
});

describe("translateResponse / translateChunk", () => {
  test("maps a completion to the unified shape", () => {
    const res = translateResponse(completionJson(), "gpt-4o-mini");
    expect(res.provider).toBe("openai");
    expect(res.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(res.choices[0]!.message).toEqual({ role: "assistant", content: "hello" });
    expect(res.choices[0]!.finish_reason).toBe("stop");
  });

  test("maps stream chunks; keeps usage-only trailing chunk; drops junk", () => {
    const chunk = translateChunk(JSON.parse(chunkJson()), "gpt-4o-mini");
    expect(chunk).not.toBeNull();
    expect(chunk!.delta.content).toBe("hi");

    const usageOnly = translateChunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, "m");
    expect(usageOnly?.usage?.total_tokens).toBe(2);

    expect(translateChunk({}, "m")).toBeNull();
  });
});

describe("OpenAIAdapter", () => {
  test("complete() hits /chat/completions with bearer auth", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const adapter = new OpenAIAdapter();
    const res = await adapter.complete(route(), "secret-key", req, { fetchImpl: mock.fetch });

    expect(res.choices[0]!.message.content).toBe("hello");
    expect(mock.calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(mock.header(0, "authorization")).toBe("Bearer secret-key");
  });

  test("honors baseUrl overrides (openai-compatible providers)", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const adapter = new OpenAIAdapter();
    await adapter.complete(route({ baseUrl: "https://api.groq.com/openai/v1/" }), "k", req, {
      fetchImpl: mock.fetch,
    });
    expect(mock.calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  test("maps 429 + Retry-After to a rate_limit ProviderError", async () => {
    const mock = new MockFetch(jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "2" }));
    const adapter = new OpenAIAdapter();
    try {
      await adapter.complete(route(), "k", req, { fetchImpl: mock.fetch });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.kind).toBe("rate_limit");
      expect(pe.status).toBe(429);
      expect(pe.retryAfterMs).toBe(2_000);
      expect(pe.message).toContain("slow down");
    }
  });

  test("maps auth failures to a non-retryable kind", async () => {
    const mock = new MockFetch(jsonResponse(401, { error: { message: "bad key" } }));
    const adapter = new OpenAIAdapter();
    try {
      await adapter.complete(route(), "k", req, { fetchImpl: mock.fetch });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).kind).toBe("auth");
    }
  });

  test("stream() yields unified chunks until [DONE]", async () => {
    const mock = new MockFetch(sseResponse([chunkJson(), chunkJson({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })]));
    const adapter = new OpenAIAdapter();
    const stream = await adapter.stream(route(), "k", req, { fetchImpl: mock.fetch });

    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.delta.content).toBe("hi");
    expect(chunks[1]!.finish_reason).toBe("stop");
  });

  test("stream() throws before returning when HTTP fails (pre-first-token)", async () => {
    const mock = new MockFetch(jsonResponse(500, { error: { message: "boom" } }));
    const adapter = new OpenAIAdapter();
    try {
      await adapter.stream(route(), "k", req, { fetchImpl: mock.fetch });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).kind).toBe("server");
    }
  });
});
