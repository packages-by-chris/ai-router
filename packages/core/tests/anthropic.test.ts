import { describe, expect, test } from "bun:test";
import { ProviderError } from "../src/errors.js";
import {
  AnthropicAdapter,
  mapFinishReason,
  translateRequest,
  translateResponse,
} from "../src/providers/anthropic.js";
import type { NormalizedRoute } from "../src/providers/types.js";
import type { ChatRequest } from "../src/types.js";
import { MockFetch, jsonResponse, sseResponse } from "./helpers.js";

function route(overrides: Partial<NormalizedRoute> = {}): NormalizedRoute {
  return {
    id: "claude",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    keyPool: ["ak1"],
    headers: {},
    maxRetries: 0,
    timeoutMs: 5_000,
    limits: {},
    ...overrides,
  };
}

describe("translateRequest", () => {
  test("extracts system messages to top-level system", () => {
    const body = translateRequest(
      {
        model: "x",
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      },
      "claude-sonnet-4-6",
      false,
    );
    expect(body.system).toBe("be terse");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("defaults max_tokens (Anthropic requires it)", () => {
    const body = translateRequest({ model: "x", messages: [{ role: "user", content: "hi" }] }, "m", false);
    expect(body.max_tokens).toBe(4096);
  });

  test("maps stop to stop_sequences and passes sampling params", () => {
    const body = translateRequest(
      { model: "x", messages: [{ role: "user", content: "hi" }], stop: ["END"], temperature: 0.5, top_p: 0.9 },
      "m",
      false,
    );
    expect(body.stop_sequences).toEqual(["END"]);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
  });

  test("maps tools to input_schema and tool_choice variants", () => {
    const tools = [
      { type: "function" as const, function: { name: "get_weather", description: "w", parameters: { type: "object" } } },
    ];
    const base = { model: "x", messages: [{ role: "user", content: "hi" }], tools };
    expect(translateRequest({ ...base }, "m", false).tools).toEqual([
      { name: "get_weather", description: "w", input_schema: { type: "object" } },
    ]);
    expect(translateRequest({ ...base, tool_choice: "auto" }, "m", false).tool_choice).toEqual({ type: "auto" });
    expect(translateRequest({ ...base, tool_choice: "required" }, "m", false).tool_choice).toEqual({ type: "any" });
    expect(
      translateRequest({ ...base, tool_choice: { type: "function", function: { name: "get_weather" } } }, "m", false)
        .tool_choice,
    ).toEqual({ type: "tool", name: "get_weather" });
  });

  test("tool_choice none drops tools entirely", () => {
    const body = translateRequest(
      {
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
        tool_choice: "none",
      },
      "m",
      false,
    );
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  test("converts assistant tool_calls into tool_use blocks with parsed input", () => {
    const body = translateRequest(
      {
        model: "x",
        messages: [
          { role: "user", content: "weather?" },
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
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "22C" }] },
    ]);
  });

  test("merges consecutive same-role messages into one turn", () => {
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
    expect(body.system).toBe("s1\n\ns2");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ]);
  });

  test("maps multimodal parts to image blocks (data URI + URL)", () => {
    const body = translateRequest(
      {
        model: "x",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "image_url", image_url: { url: "https://ex.com/cat.jpg", detail: "low" } },
            ],
          },
        ],
      },
      "m",
      false,
    );
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "image", source: { type: "url", url: "https://ex.com/cat.jpg" } },
        ],
      },
    ]);
  });

  test("stream mode sets stream flag", () => {
    const body = translateRequest({ model: "x", messages: [{ role: "user", content: "hi" }] }, "m", true);
    expect(body.stream).toBe(true);
  });
});

describe("mapFinishReason", () => {
  test("maps the known vocabulary; unknown passes through", () => {
    expect(mapFinishReason("end_turn")).toBe("stop");
    expect(mapFinishReason("stop_sequence")).toBe("stop");
    expect(mapFinishReason("pause_turn")).toBe("stop");
    expect(mapFinishReason("max_tokens")).toBe("length");
    expect(mapFinishReason("tool_use")).toBe("tool_calls");
    expect(mapFinishReason("refusal")).toBe("content_filter");
    expect(mapFinishReason("weird")).toBe("weird");
    expect(mapFinishReason(undefined)).toBeNull();
  });
});

describe("translateResponse", () => {
  test("joins text blocks and converts tool_use blocks", () => {
    const res = translateResponse(
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me check. " },
          { type: "text", text: "One moment." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude-sonnet-4-6",
    );
    expect(res.provider).toBe("anthropic");
    expect(res.choices[0]!.message.content).toBe("Let me check. One moment.");
    expect(res.choices[0]!.finish_reason).toBe("tool_calls");
    expect(res.choices[0]!.message.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    ]);
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  test("pure tool-call response has null content", () => {
    const res = translateResponse(
      {
        id: "msg_2",
        model: "m",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "f", input: {} }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      "m",
    );
    expect(res.choices[0]!.message.content).toBeNull();
  });
});

describe("AnthropicAdapter", () => {
  const req: ChatRequest = { model: "claude", messages: [{ role: "user", content: "hi" }] };

  test("complete() hits /messages with x-api-key + version headers", async () => {
    const mock = new MockFetch(
      jsonResponse(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );
    const adapter = new AnthropicAdapter();
    const res = await adapter.complete(route(), "secret", req, { fetchImpl: mock.fetch });

    expect(mock.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(mock.header(0, "x-api-key")).toBe("secret");
    expect(mock.header(0, "anthropic-version")).toBe("2023-06-01");
    expect(res.choices[0]!.message.content).toBe("hello");
    expect(res.usage?.total_tokens).toBe(5);
  });

  test("429 maps to rate_limit with Retry-After", async () => {
    const mock = new MockFetch(
      jsonResponse(429, { type: "error", error: { type: "rate_limit_error", message: "slow" } }, { "retry-after": "3" }),
    );
    try {
      await new AnthropicAdapter().complete(route(), "k", req, { fetchImpl: mock.fetch });
      throw new Error("should have thrown");
    } catch (err) {
      const pe = err as ProviderError;
      expect(pe.kind).toBe("rate_limit");
      expect(pe.retryAfterMs).toBe(3_000);
    }
  });

  test("stream() translates the typed event protocol into unified chunks", async () => {
    const events = [
      JSON.stringify({ type: "message_start", message: { id: "msg_9", model: "claude-sonnet-4-6", usage: { input_tokens: 7 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const mock = new MockFetch(sseResponse(events));
    const stream = await new AnthropicAdapter().stream(route(), "k", req, { fetchImpl: mock.fetch });

    const chunks = [];
    for await (const c of stream) chunks.push(c);

    expect(chunks[0]!.delta.role).toBe("assistant");
    expect(chunks[1]!.delta.content).toBe("Hel");
    expect(chunks[2]!.delta.content).toBe("lo");
    const last = chunks[chunks.length - 1]!;
    expect(last.finish_reason).toBe("stop");
    expect(last.usage).toEqual({ prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 });
  });

  test("stream() emits incremental tool_call deltas", async () => {
    const events = [
      JSON.stringify({ type: "message_start", message: { id: "msg_t", usage: { input_tokens: 5 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "get_weather" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"Paris"}' } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const mock = new MockFetch(sseResponse(events));
    const stream = await new AnthropicAdapter().stream(route(), "k", req, { fetchImpl: mock.fetch });

    const chunks = [];
    for await (const c of stream) chunks.push(c);

    expect(chunks[1]!.delta.tool_calls![0]).toMatchObject({ index: 0, id: "tu_1", function: { name: "get_weather" } });
    expect(chunks[2]!.delta.tool_calls![0]!.function!.arguments).toBe('{"city":');
    expect(chunks[chunks.length - 1]!.finish_reason).toBe("tool_calls");
  });

  test("mid-stream error events surface as retryable-classified ProviderErrors after commit", async () => {
    const encoder = new TextEncoder();
    const flaky = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: {} } })}\n\n`));
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`));
      },
    });
    const mock = new MockFetch(new Response(flaky, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const stream = await new AnthropicAdapter().stream(route(), "k", req, { fetchImpl: mock.fetch });

    const chunks = [];
    try {
      for await (const c of stream) chunks.push(c);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ProviderError).kind).toBe("server"); // overloaded -> retryable
      expect(chunks.length).toBeGreaterThanOrEqual(1); // committed before failing
    }
  });
});
