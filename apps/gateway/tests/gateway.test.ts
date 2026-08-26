import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { AIRouter } from "@ai-router/core";
import { createGatewayServer } from "../src/server.js";

/** Mock OpenAI-compatible upstream: echoes text, supports stream flag. */
function mockUpstream(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; stream?: boolean; messages?: Array<{ content: string }> };
      const last = body.messages?.at(-1)?.content ?? "";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const word of String(last).split(" ")) {
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
            })}\n\n`,
          );
        }
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
              { index: 0, message: { role: "assistant", content: `echo:${last}` }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
        );
      }
    });
  });
  return listen(server);
}

function listen(server: Server): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("gateway", () => {
  let upstream: { server: Server; url: string };
  let gw: { server: Server; url: string };

  beforeAll(async () => {
    upstream = await mockUpstream();
    const router = new AIRouter({
      routes: [
        {
          id: "test",
          provider: "openai-compatible",
          baseUrl: upstream.url,
          model: "mock-model",
          apiKey: "sk-upstream",
        },
      ],
    });
    gw = await listen(createGatewayServer({ router, apiKey: "gateway-key" }));
  });

  afterAll(() => {
    upstream.server.close();
    gw.server.close();
  });

  const post = (
    path: string,
    body: unknown,
    key = "gateway-key",
    extraHeaders: Record<string, string> = {},
  ) =>
    fetch(`${gw.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });

  it("lists route ids as models", async () => {
    const res = await fetch(`${gw.url}/v1/models`, {
      headers: { authorization: "Bearer gateway-key" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ object: "list", data: [{ id: "test" }] });
  });

  it("rejects missing/invalid bearer key", async () => {
    expect((await fetch(`${gw.url}/v1/models`)).status).toBe(401);
    const bad = await fetch(`${gw.url}/v1/models`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(bad.status).toBe(401);
  });

  it("proxies non-streaming completions", async () => {
    const res = await post("/v1/chat/completions", {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]!.message.content).toBe("echo:hi");
  });

  it("streams SSE frames ending with [DONE]", async () => {
    const res = await post("/v1/chat/completions", {
      model: "test",
      stream: true,
      messages: [{ role: "user", content: "a b" }],
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const frames = text
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)) as { object: string; choices: Array<{ delta: { content?: string }; finish_reason: string | null }> });
    expect(frames[0]!.object).toBe("chat.completion.chunk");
    const content = frames.map((f) => f.choices[0]?.delta.content ?? "").join("");
    expect(content.trim()).toBe("a b");
    expect(frames.at(-1)!.choices[0]!.finish_reason).toBe("stop");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("maps unknown route id to 400", async () => {
    const res = await post("/v1/chat/completions", {
      model: "nope",
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("exposes routing observability headers (non-stream + stream)", async () => {
    const plain = await post("/v1/chat/completions", {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(plain.headers.get("x-ai-router-route")).toBe("test");
    expect(plain.headers.get("x-ai-router-model")).toBe("mock-model");
    expect(Number(plain.headers.get("x-ai-router-attempts"))).toBeGreaterThanOrEqual(1);

    const streamed = await post("/v1/chat/completions", {
      model: "test",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(streamed.headers.get("x-ai-router-route")).toBe("test");
    await streamed.text();
  });

  it("GET /admin/stats returns engine snapshot, auth-gated", async () => {
    const denied = await fetch(`${gw.url}/admin/stats`);
    expect(denied.status).toBe(401);

    const res = await fetch(`${gw.url}/admin/stats`, {
      headers: { authorization: "Bearer gateway-key" },
    });
    expect(res.status).toBe(200);
    const stats = (await res.json()) as { strategy: string; health: unknown[] };
    expect(stats.strategy).toBe("fallback");
    expect(Array.isArray(stats.health)).toBe(true);
  });

  it("accepts x-routing-* headers as per-call constraints", async () => {
    // Soft knobs pass through (mock route is unpriced/unobserved/undeclared,
    // so cost/latency/task can't eliminate it).
    const res = await post(
      "/v1/chat/completions",
      { model: "test", messages: [{ role: "user", content: "hi" }] },
      "gateway-key",
      {
        "x-routing-task": "support",
        "x-routing-max-cost-usd": "0.5",
        "x-routing-max-latency-ms": "5000",
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ object: "chat.completion" });

    // Hard constraint reaches the engine: route declares no capabilities,
    // so requiring tools must eliminate it → chain exhausted.
    const strict = await post(
      "/v1/chat/completions",
      { model: "test", messages: [{ role: "user", content: "hi" }] },
      "gateway-key",
      { "x-routing-require-tools": "true" },
    );
    expect(strict.status).toBe(502);
    await strict.text();
  });

  it("maps all-routes-failed to 502", async () => {
    await upstream.server.close();
    const res = await post("/v1/chat/completions", {
      model: "test",
      max_tokens: 5,
      messages: [{ role: "user", content: "down" }],
    });
    expect([502, 500]).toContain(res.status); // network errors surface as upstream failure
    // restore for other tests' teardown symmetry (already closed; no-op)
  });
});
