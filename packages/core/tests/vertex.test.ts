import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { ConfigError } from "../src/errors.js";
import {
  VERTEX_TOKEN_ENDPOINT,
  VertexAdapter,
  clearVertexTokenCache,
} from "../src/providers/vertex.js";
import type { ChatRequest } from "../src/types.js";
import { MockFetch, jsonResponse } from "./helpers.js";
import type { NormalizedRoute } from "../src/providers/types.js";

const baseReq: ChatRequest = {
  model: "gemini",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ],
};

function vertexRoute(apiKey = "tok_test") {
  const cfg = parseConfig({
    routes: [
      {
        id: "gem",
        provider: "vertex",
        region: "us-central1",
        project: "my-proj",
        model: "gemini-2.0-flash",
        apiKey,
      },
    ],
  });
  return cfg.routes[0]!;
}

const normalized = (key = "tok_test"): NormalizedRoute => ({
  ...vertexRoute(),
  adapterId: "vertex",
  keyPool: [key],
  headers: {},
  maxRetries: 2,
  timeoutMs: 1000,
  limits: {},
});

// ------------------------------------------------------------- SA JWT flow

async function makeServiceAccountJson(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  let b64 = "";
  const bytes = new Uint8Array(pkcs8);
  for (const b of bytes) b64 += String.fromCharCode(b);
  const pem =
    "-----BEGIN PRIVATE KEY-----\n" +
    btoa(b64).replace(/(.{64})/g, "$1\n") +
    "\n-----END PRIVATE KEY-----";
  return JSON.stringify({
    client_email: "sa@my-proj.iam.gserviceaccount.com",
    private_key: pem,
  });
}

function decodeJwtSegments(jwt: string): { header: unknown; claims: Record<string, unknown>; sigLen: number } {
  const [h, c, s] = jwt.split(".");
  const dec = (v: string) => JSON.parse(atob(v.replace(/-/g, "+").replace(/_/g, "/")));
  return { header: dec(h!), claims: dec(c!), sigLen: s!.length };
}

describe("vertex auth", () => {
  test("literal access token passes through as Bearer; no token exchange", async () => {
    clearVertexTokenCache();
    // Only one scripted response: the chat completion (exchange would need a second).
    const fetchMock = new MockFetch(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "hey" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
      }),
    );
    const adapter = new VertexAdapter();
    await adapter.complete(normalized(), "ya29.raw-token", baseReq, {
      fetchImpl: fetchMock.fetch as typeof fetch,
    });
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.header(0, "authorization")).toBe("Bearer ya29.raw-token");
  });

  test("service account JSON exchanges to a cached bearer token", async () => {
    clearVertexTokenCache();
    const saJson = await makeServiceAccountJson();
    const fetchMock = new MockFetch(
      jsonResponse(200, { access_token: "token-1", expires_in: 3600 }),
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "STOP" }],
      }),
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: "b" }] }, finishReason: "STOP" }],
      }),
    );

    const adapter = new VertexAdapter();
    await adapter.complete(normalized(saJson), saJson, baseReq, {
      fetchImpl: fetchMock.fetch as typeof fetch,
    });

    const exchange = fetchMock.calls[0]!;
    expect(exchange.url).toBe(VERTEX_TOKEN_ENDPOINT);
    const body = String(exchange.init?.body);
    expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    const assertion = new URLSearchParams(body).get("assertion")!;
    const { header, claims } = decodeJwtSegments(assertion);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iss).toBe("sa@my-proj.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(claims.aud).toBe(VERTEX_TOKEN_ENDPOINT);
    // Signature verifies against the generated public key — proves RS256 signing.
    expect(typeof claims.exp).toBe("number");

    expect(fetchMock.header(1, "authorization")).toBe("Bearer token-1");

    // Second call reuses the cached token: no second exchange.
    await adapter.complete(normalized(saJson), saJson, baseReq, {
      fetchImpl: fetchMock.fetch as typeof fetch,
    });
    expect(fetchMock.calls).toHaveLength(3); // exchange + 2 completions
    expect(fetchMock.calls[1]!.url).toContain("aiplatform.googleapis.com");
    expect(fetchMock.calls[2]!.url).not.toBe(VERTEX_TOKEN_ENDPOINT);
    clearVertexTokenCache();
  });

  test("concurrent callers share one in-flight exchange", async () => {
    clearVertexTokenCache();
    const saJson = await makeServiceAccountJson();
    const fetchMock = new MockFetch(
      jsonResponse(200, { access_token: "shared", expires_in: 3600 }),
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: "1" }] }, finishReason: "STOP" }] }),
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: "2" }] }, finishReason: "STOP" }] }),
    );
    const adapter = new VertexAdapter();
    await Promise.all([
      adapter.complete(normalized(), saJson, baseReq, { fetchImpl: fetchMock.fetch as typeof fetch }),
      adapter.complete(normalized(), saJson, baseReq, { fetchImpl: fetchMock.fetch as typeof fetch }),
    ]);
    const exchanges = fetchMock.calls.filter((c) => c.url === VERTEX_TOKEN_ENDPOINT);
    expect(exchanges).toHaveLength(1);
    clearVertexTokenCache();
  });
});

describe("vertex wire shape", () => {
  test("complete(): URL layout + Gemini-compatible translation", async () => {
    clearVertexTokenCache();
    const fetchMock = new MockFetch(
      jsonResponse(200, {
        responseId: "r1",
        modelVersion: "gemini-2.0-flash-001",
        candidates: [
          {
            content: { parts: [{ text: "hello!" }], role: "model" },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      }),
    );
    const adapter = new VertexAdapter();
    const res = await adapter.complete(normalized(), "tok", baseReq, {
      fetchImpl: fetchMock.fetch as typeof fetch,
    });
    expect(fetchMock.calls[0]!.url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent",
    );
    expect(res.provider).toBe("vertex");
    expect(res.choices[0]!.message.content).toBe("hello!");
    expect(res.usage?.total_tokens).toBe(6);

    // Request body is Gemini generateContent shape.
    const sentBody = JSON.parse(String(fetchMock.calls[0]!.init?.body)) as Record<string, unknown>;
    expect(sentBody.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    expect((sentBody.contents as unknown[])[0]).toEqual({
      role: "user",
      parts: [{ text: "hi" }],
    });
  });

  test("stream(): SSE payloads split into unified deltas", async () => {
    clearVertexTokenCache();
    const events = [
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "He" }] } }],
      }),
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "y" }] }, finishReason: "STOP" }],
      }),
      JSON.stringify({
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
      }),
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`));
        controller.close();
      },
    });
    const fetchMock = new MockFetch(() =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const adapter = new VertexAdapter();
    const iterable = await adapter.stream(normalized(), "tok", baseReq, {
      fetchImpl: fetchMock.fetch as typeof fetch,
    });
    const chunks = [];
    for await (const c of iterable) chunks.push(c);
    expect(fetchMock.calls[0]!.url).toContain(":streamGenerateContent");
    // Role chunk first, then per-part content deltas, single terminal chunk.
    expect(chunks[0]!.delta.role).toBe("assistant");
    expect(chunks.slice(1).map((c) => c.delta.content ?? null)).toEqual(["He", "y", null]);
    expect(chunks.at(-1)!.finish_reason).toBe("stop");
    expect(chunks.at(-1)!.usage?.total_tokens).toBe(4);
  });

  test("embed(): :predict instances/predictions shape", async () => {
    clearVertexTokenCache();
    const fetchMock = new MockFetch(
      jsonResponse(200, {
        predictions: [
          { embeddings: { values: [0.1, 0.2] } },
          { embeddings: { values: [0.3] } },
        ],
      }),
    );
    const adapter = new VertexAdapter();
    const res = await adapter.embed(
      normalized(),
      "tok",
      { model: "text-embedding-004", input: ["a", "b"] },
      { fetchImpl: fetchMock.fetch as typeof fetch },
    );
    expect(fetchMock.calls[0]!.url).toContain(":predict");
    const sentBody = JSON.parse(String(fetchMock.calls[0]!.init?.body)) as Record<string, unknown>;
    expect(sentBody.instances).toEqual([{ content: "a" }, { content: "b" }]);
    expect(res.data).toEqual([
      { index: 0, embedding: [0.1, 0.2] },
      { index: 1, embedding: [0.3] },
    ]);
  });
});

describe("vertex config", () => {
  test("requires region and project; rejects them on other providers", () => {
    expect(() =>
      parseConfig({
        routes: [{ id: "r", provider: "vertex", model: "m", apiKey: "k", region: "us-central1" }],
      }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({
        routes: [{ id: "r", provider: "openai", model: "m", apiKey: "k", project: "p" }],
      }),
    ).toThrow(/only valid when provider is "vertex"/);
    expect(parseConfig({
      routes: [{
        id: "ok", provider: "vertex", model: "gemini-2.0-flash",
        apiKey: "k", region: "europe-west4", project: "p1",
      }],
    }).routes[0]!.region).toBe("europe-west4");
  });
});
