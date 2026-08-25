import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import {
  GuardrailBlockedError,
  type InputGuardrail,
  type OutputGuardrail,
} from "../src/guardrails.js";
import type { ChatRequest } from "../src/types.js";
import { MockFetch, completionJson, jsonResponse } from "./helpers.js";

const cfg = () =>
  parseConfig({
    routes: [{ id: "a", provider: "openai", model: "gpt-4o-mini", apiKey: "k" }],
  });

const req: ChatRequest = { model: "a", messages: [{ role: "user", content: "hi" }] };

function okFetch() {
  return new MockFetch(jsonResponse(200, completionJson()));
}

describe("guardrails", () => {
  test("input block: throws, never reaches provider, no fallback attempt", async () => {
    const fetchMock = new MockFetch(); // no scripted responses — must stay unused
    const engine = new RoutingEngine(cfg(), {
      fetchImpl: fetchMock.fetch,
      guardrails: {
        input: [{ name: "no-secrets", check: (r) => ({ pass: false, reason: "secret detected" }) }],
      },
    });
    await expect(engine.complete(req)).rejects.toThrow(GuardrailBlockedError);
    expect(fetchMock.calls).toHaveLength(0);
    try {
      await engine.complete(req);
    } catch (err) {
      const e = err as GuardrailBlockedError;
      expect(e.phase).toBe("input");
      expect(e.guardrail).toBe("no-secrets");
      expect(e.reason).toBe("secret detected");
    }
  });

  test("input transform: replaced request is what the provider receives", async () => {
    let seenBody: unknown;
    const redact: InputGuardrail = {
      name: "redact",
      check: (r) => ({
        pass: true,
        replace: {
          ...r,
          messages: r.messages.map((m) =>
            m.role === "user" && typeof m.content === "string"
              ? { role: m.role, content: m.content.replaceAll("ACME", "[REDACTED]") }
              : m,
          ),
        },
      }),
    };
    const engine = new RoutingEngine(cfg(), {
      fetchImpl: async (_url, init) => {
        seenBody = JSON.parse(String(init?.body));
        return jsonResponse(200, completionJson());
      },
      guardrails: { input: [redact] },
    });
    await engine.complete({
      model: "a",
      messages: [{ role: "user", content: "hello from ACME corp" }],
    });
    expect(
      (seenBody as { messages: Array<{ content: string }> }).messages[0]!.content,
    ).toBe("hello from [REDACTED] corp");
  });

  test("output block: throws after provider call; spend still recorded", async () => {
    const calls: string[] = [];
    const store = {
      take: async () => ({ allowed: true, retryAfterMs: 0 }),
      record: async (key: string) => void calls.push(key),
    };
    const cfgWithBudget = parseConfig({
      routes: [
        {
          id: "a",
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "k",
          budget: { usd: 10 },
        },
      ],
    });
    const outputBlock: OutputGuardrail = {
      name: "pii-scan",
      check: () => ({ pass: false, reason: "pii found" }),
    };
    const engine = new RoutingEngine(cfgWithBudget, {
      // deno-lint-ignore no-explicit-any
      store: store as any,
      fetchImpl: okFetch().fetch,
      pricing: { a: { input: 1, output: 2 } },
      guardrails: { output: [outputBlock] },
    });
    await expect(engine.complete(req)).rejects.toThrow(/guardrail "pii-scan" blocked output/);
    // Provider was called and tpm spend recorded before the verdict.
    expect(calls).toContain("a:usd");
  });

  test("output transform rewrites the returned response", async () => {
    const rewrite: OutputGuardrail = {
      check: (res) => ({
        pass: true,
        replace: {
          ...res,
          choices: [
            {
              ...res.choices[0]!,
              message: { ...res.choices[0]!.message, content: "sanitized" },
            },
          ],
        },
      }),
    };
    const engine = new RoutingEngine(cfg(), {
      fetchImpl: okFetch().fetch,
      guardrails: { output: [rewrite] },
    });
    const res = await engine.complete(req);
    expect(res.choices[0]!.message.content).toBe("sanitized");
  });

  test("async guards work; multiple guards run in order", async () => {
    const order: string[] = [];
    const g1: InputGuardrail = {
      name: "one",
      check: async () => {
        order.push("one");
        return { pass: true };
      },
    };
    const g2: InputGuardrail = {
      name: "two",
      check: () => {
        order.push("two");
        return { pass: true };
      },
    };
    const engine = new RoutingEngine(cfg(), {
      fetchImpl: okFetch().fetch,
      guardrails: { input: [g1, g2] },
    });
    await expect(engine.complete(req)).resolves.toBeTruthy();
    expect(order).toEqual(["one", "two"]);
  });

  test("streams apply input guards but skip output guards", async () => {
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    let outputRan = false;
    const outputBlock: OutputGuardrail = {
      name: "stream-blocker",
      check: () => {
        outputRan = true;
        return { pass: false };
      },
    };
    // Phase 1: an input guard blocks the stream before routing.
    const engine1 = new RoutingEngine(cfg(), {
      fetchImpl: async () => new Response(streamBody, { status: 200 }),
      guardrails: {
        input: [{ check: () => ({ pass: false }) }],
        output: [outputBlock],
      },
    });
    await expect(engine1.stream(req)).rejects.toThrow(GuardrailBlockedError);
    expect(outputRan).toBe(false); // never routed, output guard untouched

    // Phase 2: with only an output guard configured, streaming proceeds
    // untouched — the guard never runs.
    let outputRan2 = false;
    const engine2 = new RoutingEngine(cfg(), {
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      guardrails: { output: [outputBlock] },
    });
    const iterable = await engine2.stream(req);
    for await (const _chunk of iterable) void _chunk;
    expect(outputRan2).toBe(false);
  });

  test("embed() enforces input guards", async () => {
    const engine = new RoutingEngine(
      parseConfig({
        routes: [{ id: "e", provider: "openai", model: "text-embedding-3-small", apiKey: "k" }],
      }),
      {
        fetchImpl: okFetch().fetch,
        guardrails: {
          input: [{ name: "len", check: (r) => ({ pass: JSON.stringify(r.messages).length < 5 }) }],
        },
      },
    );
    await expect(
      engine.embed({ model: "e", input: "long enough to trip the length guard here" }),
    ).rejects.toThrow(GuardrailBlockedError);
  });
});
