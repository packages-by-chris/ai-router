import { afterEach, describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { RoutingEngine } from "../src/engine.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import {
  registerAdapter,
  knownProviderIds,
} from "../src/providers/registry.js";
import { PROVIDER_PRESETS, getPreset } from "../src/providers/presets.js";
import {
  runTranslationCases,
  type TranslationCase,
  type TranslationHandlers,
} from "../src/conformance/cases.js";
import type { ChatRequest } from "../src/types.js";
import { MockFetch, completionJson, jsonResponse } from "./helpers.js";

const noopSleep = async () => {};

afterEach(() => {
  // Test-only preset registrations must not leak across tests.
  delete PROVIDER_PRESETS["test-header-auth"];
});

describe("provider presets", () => {
  function groqConfig(): ReturnType<typeof parseConfig> {
    return parseConfig({
      routes: [
        { id: "fast", provider: "groq", model: "llama-3.3-70b-versatile", apiKey: "${GROQ_KEY}" },
      ],
    }, { GROQ_KEY: "k-groq" });
  }

  test("preset expands to its published baseUrl without user config", async () => {
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(groqConfig(), { fetchImpl: mock.fetch, sleep: noopSleep });
    await engine.complete({ model: "fast", messages: [{ role: "user", content: "hi" }] });
    expect(mock.calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(mock.header(0, "authorization")).toBe("Bearer k-groq");
  });

  test("explicit baseUrl overrides the preset", async () => {
    const cfg = parseConfig({
      routes: [{
        id: "r", provider: "groq", model: "m", apiKey: "k",
        baseUrl: "https://proxy.internal/groq/v1",
      }],
    });
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(cfg, { fetchImpl: mock.fetch, sleep: noopSleep });
    await engine.complete({ model: "r", messages: [{ role: "user", content: "hi" }] });
    expect(mock.calls[0]!.url).toBe("https://proxy.internal/groq/v1/chat/completions");
  });

  test("keyless no-auth presets (ollama) parse and route", async () => {
    const cfg = parseConfig({
      routes: [{ id: "local", provider: "ollama", model: "llama3.2" }],
    });
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(cfg, { fetchImpl: mock.fetch, sleep: noopSleep });
    const res = await engine.complete({ model: "local", messages: [{ role: "user", content: "hi" }] });
    expect(mock.calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(res.provider).toBe("ollama"); // preset ids label responses directly
  });

  test("preset auth {header} sends the key in that header, not Bearer", async () => {
    PROVIDER_PRESETS["test-header-auth"] = {
      adapter: "openai-compatible",
      baseUrl: "https://hdr.example/v1",
      auth: { header: "x-custom-key" },
      headers: { "x-static": "1" },
    };
    const cfg = parseConfig({
      routes: [{ id: "r", provider: "test-header-auth", model: "m", apiKey: "sekret" }],
    });
    const mock = new MockFetch(jsonResponse(200, completionJson()));
    const engine = new RoutingEngine(cfg, { fetchImpl: mock.fetch, sleep: noopSleep });
    await engine.complete({ model: "r", messages: [{ role: "user", content: "hi" }] });
    expect(mock.header(0, "x-custom-key")).toBe("sekret");
    expect(mock.header(0, "authorization")).toBeUndefined();
    expect(mock.header(0, "x-static")).toBe("1"); // preset static headers merged
  });

  test("unknown preset-like provider fails with the full known list", () => {
    expect(() =>
      parseConfig({ routes: [{ id: "r", provider: "groq ", model: "m", apiKey: "k" }] }),
    ).toThrow(/known: .*groq/);
  });

  test("getPreset covers the catalog and knownProviderIds unions it", () => {
    expect(getPreset("deepseek")!.baseUrl).toContain("deepseek");
    for (const id of ["groq", "ollama"]) {
      expect(knownProviderIds()).toContain(id);
    }
  });
});

describe("registerAdapter (third-party providers)", () => {
  function makeEchoAdapter(): ProviderAdapter {
    return {
      id: "echo",
      label: "echo",
      async complete(_route, _key, req) {
        return {
          id: "echo-1",
          model: req.model,
          provider: "echo",
          created: 0,
          usage: null,
          choices: [{
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: `echo:${req.messages[0]!.content ?? ""}` },
          }],
        } as Awaited<ReturnType<ProviderAdapter["complete"]>>;
      },
      async stream() {
        throw new Error("not needed in test");
      },
      async raw() {
        throw new Error("not needed in test");
      },
    } as ProviderAdapter;
  }

  test("custom adapter serves routes end-to-end after registration", async () => {
    registerAdapter("echo-test", makeEchoAdapter);
    try {
      expect(knownProviderIds()).toContain("echo-test");
      const cfg = parseConfig({
        routes: [{ id: "r", provider: "echo-test", model: "anything", apiKey: "k" }],
      });
      const engine = new RoutingEngine(cfg, { sleep: noopSleep });
      const res = await engine.complete({
        model: "r",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(res.choices[0]!.message.content).toBe("echo:hello");
    } finally {
      // No unregister API; unique ids per run keep tests isolated.
    }
  });

  test("colliding with a built-in id or malformed id throws", () => {
    expect(() => registerAdapter("openai", makeEchoAdapter)).toThrow(/collides/);
    expect(() => registerAdapter("1bad", makeEchoAdapter)).toThrow(/must match/);
    expect(() => registerAdapter("has space", makeEchoAdapter)).toThrow(/must match/);
  });

  test("unregistered custom provider still rejected at parse time", () => {
    expect(() =>
      parseConfig({ routes: [{ id: "r", provider: "bedrock", model: "m", apiKey: "k" }] }),
    ).toThrow(/unknown provider "bedrock"/);
  });
});

describe("conformance kit for external adapters", () => {
  const cases: TranslationCase[] = [
    {
      name: "echo request translation",
      kind: "echo_request",
      providerModel: "m",
      stream: false,
      request: { model: "route", messages: [{ role: "user", content: "hi" }] },
      expected: { model: "m", text: "hi" },
    },
  ];

  const handlers: TranslationHandlers = {
    echo_request: ({ request, providerModel }) => ({
      model: providerModel,
      text: (request as ChatRequest).messages[0]!.content ?? "",
    }),
  };

  test("runTranslationCases diffs against stable JSON", () => {
    const { total, failed, results } = runTranslationCases(cases, handlers);
    expect(total).toBe(1);
    expect(failed).toBe(0);
    expect(results[0]!.ok).toBe(true);

    const broken = runTranslationCases(
      [{ ...cases[0]!, expected: { model: "m", text: "different" } }],
      handlers,
    );
    expect(broken.failed).toBe(1);
    expect(broken.results[0]!.expected).toContain('"text":"different"');
  });

  test("missing handler kind fails cleanly instead of throwing", () => {
    const { results } = runTranslationCases(cases); // no handlers passed
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.actual).toContain("no handler for kind");
  });
});
