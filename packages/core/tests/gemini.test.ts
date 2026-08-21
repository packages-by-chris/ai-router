import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/errors.js";
import {
  GeminiAdapter,
  mapFinishReason,
  translateRequest,
  translateResponse,
} from "../src/providers/gemini.js";
import type { NormalizedRoute } from "../src/providers/types.js";
import type { ChatRequest } from "../src/types.js";
import { MockFetch, jsonResponse, sseResponse } from "./helpers.js";

function route(overrides: Partial<NormalizedRoute> = {}): NormalizedRoute {
  return {
    id: "flash",
    provider: "gemini",
    model: "gemini-2.0-flash",
    keyPool: ["gk1"],
    headers: {},
    maxRetries: 0,
    timeoutMs: 5_000,
    limits: {},
    ...overrides,
  };
}

describe("translateRequest", () => {
  test("extracts system messages to systemInstruction, maps roles", () => {
    const body = translateRequest(
      {
        model: "x",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      },
      "gemini-2.0-flash",
      false,
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
  });

  test("maps sampling params into generationConfig incl. json mode", () => {
    const body = translateRequest(
      {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 256,
        stop: ["END"],
        response_format: { type: "json_object" },
      },
      "m",
      false,
    );
    expect(body.generationConfig).toEqual({
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 256,
      stopSequences: ["END"],
      responseMimeType: "application/json",
    });
  });

  test("maps tools to functionDeclarations and tool_choice variants", () => {
    const tools = [
      { type: "function" as const, function: { name: "get_weather", description: "w", parameters: { type: "object" } } },
    ];
    const base = { model: "x", messages: [{ role: "user", content: "hi" }], tools };
    expect(translateRequest({ ...base }, "m", false).tools).toEqual([
      { functionDeclarations: [{ name: "get_weather", description: "w", parameters: { type: "object" } }] },
    ]);
    expect(translateRequest({ ...base, tool_choice: "auto" }, "m", false).toolConfig).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(translateRequest({ ...base, tool_choice: "required" }, "m", false).toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY" },
    });
    expect(
      translateRequest({ ...base, tool_choice: { type: "function", function: { name: "get_weather" } } }, "m", false)
        .toolConfig,
    ).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } });
  });

  test("tool loop: functionCall parts out, functionResponse parts back (name resolved by id)", () => {
    const body = translateRequest(
      {
        model: "x",
        messages: [
          { role: "user", content: "weather in Paris?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "22C" },
        ],
      },
      "m",
      false,
    );
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "weather in Paris?" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" }, id: "call_1" } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "get_weather", id: "call_1", response: { result: "22C" } } }],
      },
    ]);
  });

  test("merges consecutive same-role messages", () => {
    const body = translateRequest(
      {
        model: "x",
        messages: [
          { role: "system", content: "s1" },
          { role: "system", content: "s2" },
          { role: "user", content: "a" },
          { role: "user", content: "b" },
        ],
      },
      "m",
      false,
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: "s1" }, { text: "s2" }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "a" }, { text: "b" }] },
    ]);
  });

  test("maps multimodal parts to inlineData/fileData", () => {
    const body = translateRequest(
      {
        model: "x",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "image_url", image_url: { url: "https://ex.com/cat.jpg" } },
            ],
          },
        ],
      },
      "m",
      false,
    );
    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "what is this?" },
          { inlineData: { mimeType: "image/png", data: "AAAA" } },
          { fileData: { mimeType: "image/jpeg", fileUri: "https://ex.com/cat.jpg" } },
        ],
      },
    ]);
  });
});

describe("mapFinishReason", () => {
  test("maps the known vocabulary; unknown passes through", () => {
    expect(mapFinishReason("STOP")).toBe("stop");
    expect(mapFinishReason("MAX_TOKENS")).toBe("length");
    expect(mapFinishReason("SAFETY")).toBe("content_filter");
    expect(mapFinishReason("RECITATION")).toBe("content_filter");
    expect(mapFinishReason("OTHER")).toBe("OTHER");
    expect(mapFinishReason(undefined)).toBeNull();
  });
});

describe("translateResponse", () => {
  test("converts text + functionCall parts; maps usageMetadata", () => {
    const res = translateResponse(
      {
        responseId: "resp_1",
        modelVersion: "gemini-2.0-flash",
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Checking. " }, { functionCall: { id: "fc_1", name: "get_weather", args: { city: "Paris" } } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
      "gemini-2.0-flash",
    );
    expect(res.provider).toBe("gemini");
    expect(res.id).toBe("resp_1");
    expect(res.choices[0]!.finish_reason).toBe("stop");
    expect(res.choices[0]!.message.content).toBe("Checking. ");
    expect(res.choices[0]!.message.tool_calls).toEqual([
      { id: "fc_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    ]);
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  test("blocked prompt (no candidates) becomes content_filter", () => {
    const res = translateResponse(
      { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0, totalTokenCount: 3 } },
      "m",
    );
    expect(res.choices[0]!.finish_reason).toBe("content_filter");
    expect(res.choices[0]!.message.content).toBe("");
  });
});

describe("GeminiAdapter", () => {
  const req: ChatRequest = { model: "flash", messages: [{ role: "user", content: "hi" }] };

  test("complete() hits models/{model}:generateContent with x-goog-api-key", async () => {
    const mock = new MockFetch(
      jsonResponse(200, {
        responseId: "r1",
        modelVersion: "gemini-2.0-flash",
        candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      }),
    );
    const res = await new GeminiAdapter().complete(route(), "secret", req, { fetchImpl: mock.fetch });

    expect(mock.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent");
    expect(mock.header(0, "x-goog-api-key")).toBe("secret");
    expect(res.choices[0]!.message.content).toBe("hello");
    expect(res.usage?.total_tokens).toBe(5);
  });

  test("429 RESOURCE_EXHAUSTED maps to rate_limit with Retry-After", async () => {
    const mock = new MockFetch(
      jsonResponse(429, { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }, { "retry-after": "2" }),
    );
    try {
      await new GeminiAdapter().complete(route(), "k", req, { fetchImpl: mock.fetch });
      throw new Error("should have thrown");
    } catch (err) {
      const pe = err as ProviderError;
      expect(pe.kind).toBe("rate_limit");
      expect(pe.retryAfterMs).toBe(2_000);
    }
  });

  test("stream() hits streamGenerateContent?alt=sse and translates chunks", async () => {
    const events = [
      JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "He" }] } }],
        usageMetadata: { promptTokenCount: 7 },
      }),
      JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "llo" }] } }] }),
      JSON.stringify({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 },
        modelVersion: "gemini-2.0-flash",
      }),
    ];
    const mock = new MockFetch(sseResponse(events));
    const stream = await new GeminiAdapter().stream(route(), "k", req, { fetchImpl: mock.fetch });

    const chunks = [];
    for await (const c of stream) chunks.push(c);

    expect(mock.calls[0]!.url).toContain(":streamGenerateContent?alt=sse");
    expect(chunks[0]!.delta.role).toBe("assistant");
    expect(chunks[1]!.delta.content).toBe("He");
    expect(chunks[2]!.delta.content).toBe("llo");
    const last = chunks[chunks.length - 1]!;
    expect(last.finish_reason).toBe("stop");
    expect(last.usage).toEqual({ prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 });
  });

  test("stream() emits complete functionCall deltas", async () => {
    const events = [
      JSON.stringify({
        candidates: [
          { content: { role: "model", parts: [{ functionCall: { id: "fc_9", name: "get_weather", args: { city: "Paris" } } }] } },
        ],
      }),
      JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 11 } }),
    ];
    const mock = new MockFetch(sseResponse(events));
    const stream = await new GeminiAdapter().stream(route(), "k", req, { fetchImpl: mock.fetch });

    const chunks = [];
    for await (const c of stream) chunks.push(c);

    expect(chunks[1]!.delta.tool_calls![0]).toMatchObject({
      index: 0,
      id: "fc_9",
      function: { name: "get_weather", arguments: '{"city":"Paris"}' },
    });
    expect(chunks[chunks.length - 1]!.finish_reason).toBe("stop");
  });

  test("mid-stream error payloads surface as ProviderErrors after commit", async () => {
    const encoder = new TextEncoder();
    const flaky = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } })}\n\n`));
      },
    });
    const mock = new MockFetch(new Response(flaky, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const stream = await new GeminiAdapter().stream(route(), "k", req, { fetchImpl: mock.fetch });

    const chunks = [];
    try {
      for await (const c of stream) chunks.push(c);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).kind).toBe("server"); // UNAVAILABLE -> retryable
      expect(chunks.length).toBeGreaterThanOrEqual(1); // committed before failing
    }
  });
});
