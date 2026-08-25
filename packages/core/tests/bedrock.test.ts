import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { ConfigError } from "../src/errors.js";
import {
  awsEventStream,
  mapBedrockStopReason,
  sigv4Headers,
  translateRequest,
  translateResponse,
  BedrockAdapter,
} from "../src/providers/bedrock.js";
import type { ChatRequest } from "../src/types.js";
import { MockFetch, jsonResponse } from "./helpers.js";

const baseReq: ChatRequest = {
  model: "claude",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ],
};

describe("bedrock translateRequest", () => {
  test("maps system/messages/sampling to Converse shape", () => {
    const body = translateRequest(
      { ...baseReq, temperature: 0.5, max_tokens: 100, stop: ["END"] },
      "anthropic.claude-3-5-sonnet-20240620-v1:0",
      false,
    );
    expect(body).toEqual({
      messages: [{ role: "user", content: [{ text: "hi" }] }],
      system: [{ text: "be brief" }],
      inferenceConfig: { temperature: 0.5, maxTokens: 100, stopSequences: ["END"] },
    });
  });

  test("tool definitions nest under toolConfig.toolSpec; choice maps", () => {
    const body = translateRequest(
      {
        ...baseReq,
        tool_choice: "required",
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "weather lookup",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      "m",
      false,
    );
    expect(body.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: "get_weather",
            description: "weather lookup",
            inputSchema: { json: { type: "object", properties: {} } },
          },
        },
      ],
      toolChoice: { any: {} },
    });
  });

  test("assistant tool_calls become toolUse blocks with parsed input", () => {
    const body = translateRequest(
      {
        model: "m",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "f", arguments: '{"x":1}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "42" },
        ],
      },
      "m",
      false,
    );
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: [{ toolUse: { toolUseId: "call_1", name: "f", input: { x: 1 } } }],
      },
      {
        role: "user",
        content: [{ toolResult: { toolUseId: "call_1", content: [{ text: "42" }] } }],
      },
    ]);
  });

  test("data-uri images translate; remote urls are dropped", () => {
    const body = translateRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "image_url", image_url: { url: "https://example.com/x.jpg" } },
            ],
          },
        ],
      },
      "m",
      false,
    );
    const content = (body.messages as Array<{ content: unknown }>)[0]!.content;
    expect(content).toEqual([
      { text: "look" },
      { image: { format: "png", source: { bytes: "AAAA" } } },
    ]);
  });

  test("providerOptions.bedrock merges last", () => {
    const body = translateRequest(
      { ...baseReq, providerOptions: { bedrock: { additionalModelRequestFields: { a: 1 } } } },
      "m",
      false,
    );
    expect(body.additionalModelRequestFields).toEqual({ a: 1 });
  });
});

describe("bedrock translateResponse / stop reasons", () => {
  test("full mapping incl. toolUse + usage", () => {
    const res = translateResponse(
      {
        messageId: "msg-1",
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        output: {
          message: {
            role: "assistant",
            content: [
              { text: "calling" },
              { toolUse: { toolUseId: "tu_1", name: "f", input: { q: "x" } } },
            ],
          },
        },
      },
      "m",
    );
    expect(res.id).toBe("msg-1");
    expect(res.provider).toBe("bedrock");
    expect(res.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(res.choices[0]!.finish_reason).toBe("tool_calls");
    expect(res.choices[0]!.message.tool_calls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: { name: "f", arguments: '{"q":"x"}' },
      },
    ]);
    expect(res.choices[0]!.message.content).toBe("calling");
  });

  test("stop reason vocabulary maps to OpenAI-style finish_reason", () => {
    expect(mapBedrockStopReason("end_turn")).toBe("stop");
    expect(mapBedrockStopReason("max_tokens")).toBe("length");
    expect(mapBedrockStopReason("content_filtered")).toBe("content_filter");
    expect(mapBedrockStopReason("guardrail_intervened")).toBe("content_filter");
    expect(mapBedrockStopReason(null)).toBe(null);
  });

  test("reasoningContent blocks map to message.reasoning", () => {
    const res = translateResponse(
      {
        stopReason: "end_turn",
        output: {
          message: {
            role: "assistant",
            content: [
              { reasoningContent: { text: "thinking..." } },
              { text: "answer" },
            ],
          },
        },
      },
      "m",
    );
    expect(res.choices[0]!.message.reasoning).toBe("thinking...");
    expect(res.choices[0]!.message.content).toBe("answer");
  });
});

describe("sigv4Headers", () => {
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI" };

  test("deterministic signature for fixed inputs (canonical-form guard)", async () => {
    const url = "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/converse";
    const a = await sigv4Headers({
      method: "POST",
      url,
      body: new TextEncoder().encode('{"x":1}'),
      credentials: creds,
      region: "us-east-1",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const b = await sigv4Headers({
      method: "POST",
      url,
      body: new TextEncoder().encode('{"x":1}'),
      credentials: creds,
      region: "us-east-1",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(a.authorization).toBe(b.authorization);
    expect(a.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260101\/us-east-1\/bedrock\/aws4_request, /);
    expect(a["x-amz-date"]).toBe("20260101T000000Z");
  });

  test("session token adds x-amz-security-token and joins SignedHeaders", async () => {
    const h = await sigv4Headers({
      method: "POST",
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse",
      body: new TextEncoder().encode("{}"),
      credentials: { ...creds, sessionToken: "TOK" },
      region: "us-east-1",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(h["x-amz-security-token"]).toBe("TOK");
    expect(h.authorization).toContain("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token");
  });
});

// ------------------------------------------------ binary eventstream parser

function encodeEventStreamMessage(headers: Array<[string, string]>, payloadJson: unknown): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  let headerBytes = new Uint8Array(0);
  for (const [name, value] of headers) {
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    const dv = new DataView(part.buffer);
    let off = 0;
    dv.setUint8(off, nameBytes.length); off += 1;
    part.set(nameBytes, off); off += nameBytes.length;
    dv.setUint8(off, 7); off += 1; // type: string
    dv.setUint16(off, valueBytes.length); off += 2;
    part.set(valueBytes, off);
    const merged = new Uint8Array(headerBytes.length + part.length);
    merged.set(headerBytes);
    merged.set(part, headerBytes.length);
    headerBytes = merged;
  }
  const totalLen = 12 + headerBytes.length + payloadBytesLength(payloadJson) + 4;
  const msg = new Uint8Array(totalLen);
  const dv = new DataView(msg.buffer);
  dv.setUint32(0, totalLen);
  dv.setUint32(4, headerBytes.length);
  // prelude crc at 8 skipped by parser
  msg.set(headerBytes, 12);
  const payload = payloadBytes(payloadJson);
  msg.set(payload, 12 + headerBytes.length);
  return msg;
}

function payloadBytes(v: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(v));
}
function payloadBytesLength(v: unknown): number {
  return payloadBytes(v).length;
}

/** ReadableStream of bytes, split into network chunks of `stride`. */
function byteBody(all: Uint8Array<ArrayBuffer>, stride: number): ReadableStream<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < all.length; i += stride) chunks.push(all.slice(i, i + stride));
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<{ headers: Map<string, string>; payload: Uint8Array }>) {
  const out: Array<{ eventType: string | undefined; json: unknown }> = [];
  for await (const m of gen) {
    out.push({
      eventType: m.headers.get(":event-type"),
      json: JSON.parse(new TextDecoder().decode(m.payload)),
    });
  }
  return out;
}

describe("awsEventStream parser", () => {
  function makeBody(chunks: Uint8Array<ArrayBuffer>[]): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
  }

  test("parses multiple events from one chunk and across chunk boundaries", async () => {
    const e1 = encodeEventStreamMessage(
      [[":message-type", "event"], [":event-type", "messageStart"]],
      {},
    );
    const e2 = encodeEventStreamMessage(
      [[":message-type", "event"], [":event-type", "contentBlockDelta"]],
      { delta: { text: "Hi" }, contentBlockIndex: 0 },
    );

    // Split mid-event: first half of e2 in chunk A, rest in chunk B.
    const splitAt = 20;
    const a = new Uint8Array(e1.length + splitAt);
    a.set(e1);
    a.set(e2.subarray(0, splitAt), e1.length);
    const b = new Uint8Array(e2.length - splitAt);
    b.set(e2.subarray(splitAt));

    const events = await collect(awsEventStream(makeBody([a, b])));
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe("messageStart");
    expect(events[1]!.eventType).toBe("contentBlockDelta");
    expect(events[1]!.json).toEqual({ delta: { text: "Hi" }, contentBlockIndex: 0 });
  });
});

// ------------------------------------------------------------ adapter wiring

function bedrockRoute() {  const cfg = parseConfig({
    routes: [
      {
        id: "claude",
        provider: "bedrock",
        region: "us-east-1",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        apiKey: "AKID:SECRET",
      },
    ],
  });
  return cfg.routes[0]!;
}

describe("bedrock adapter via mock fetch", () => {
  test("complete(): signed POST to converse endpoint, translated response", async () => {
    const route = bedrockRoute();
    const fetchMock = new MockFetch(
      jsonResponse(200, {
        messageId: "m1",
        stopReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        output: { message: { role: "assistant", content: [{ text: "hey" }] } },
      }),
    );
    const adapter = new BedrockAdapter();
    const res = await adapter.complete(
      { ...route, keyPool: ["AKID:SECRET"], headers: {}, maxRetries: 2, timeoutMs: 1000, limits: {}, baseUrl: undefined },
      "AKID:SECRET",
      baseReq,
      { fetchImpl: fetchMock.fetch as typeof fetch },
    );
    expect(res.choices[0]!.message.content).toBe("hey");
    expect(fetchMock.calls[0]!.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/converse",
    );
    const auth = fetchMock.header(0, "authorization") ?? "";
    expect(auth).toContain("Credential=AKID/");
  });

  test("stream(): parses binary eventstream into unified chunks", async () => {
    const route = bedrockRoute();
    const start = encodeEventStreamMessage([[":event-type", "messageStart"]], {});
    const delta1 = encodeEventStreamMessage(
      [[":event-type", "contentBlockDelta"]],
      { contentBlockIndex: 0, delta: { text: "Hel" } },
    );
    const delta2 = encodeEventStreamMessage(
      [[":event-type", "contentBlockDelta"]],
      { contentBlockIndex: 0, delta: { text: "lo" } },
    );
    const meta = encodeEventStreamMessage(
      [[":event-type", "metadata"]],
      { usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
    );
    const stop = encodeEventStreamMessage(
      [[":event-type", "messageStop"]],
      { stopReason: "end_turn" },
    );

    // Chunked adversarially: every event split across network chunks.
    const all = new Uint8Array([...start, ...delta1, ...delta2, ...meta, ...stop]);

    const fetchMock = new MockFetch(() =>
      new Response(byteBody(all, 7), {
        status: 200,
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      }),
    );
    const adapter = new BedrockAdapter();
    const iterable = await adapter.stream(
      { ...route, keyPool: ["AKID:SECRET"], headers: {}, maxRetries: 2, timeoutMs: 1000, limits: {}, baseUrl: undefined },
      "AKID:SECRET",
      baseReq,
      { fetchImpl: fetchMock.fetch as typeof fetch },
    );
    const collected = [];
    for await (const c of iterable) collected.push(c);
    expect(collected.map((c) => c.delta.content ?? c.delta.role ?? null)).toEqual([
      "assistant", "Hel", "lo", null,
    ]);
    expect(collected.at(-1)!.finish_reason).toBe("stop");
    expect(collected.at(-1)!.usage?.total_tokens).toBe(4);
  });

  test("config requires region", () => {
    expect(() =>
      parseConfig({
        routes: [{ id: "r", provider: "bedrock", model: "m", apiKey: "a:b" }],
      }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({
        routes: [{ id: "r", provider: "openai", model: "m", apiKey: "k", region: "us-east-1" }],
      }),
    ).toThrow(/only valid when provider is "bedrock" or "vertex"/);
  });
});
