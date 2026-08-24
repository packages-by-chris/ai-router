import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/parse.js";
import { ConfigError } from "../src/errors.js";

const valid = {
  routes: [
    { id: "fast", provider: "openai", model: "gpt-4o-mini", apiKey: "sk-1" },
  ],
};

describe("parseConfig", () => {
  test("accepts a minimal valid config", () => {
    const cfg = parseConfig(valid);
    expect(cfg.routes).toHaveLength(1);
    expect(cfg.routes[0]!.id).toBe("fast");
  });

  test("merges apiKey + apiKeys into a pool", () => {
    const cfg = parseConfig({
      routes: [
        {
          id: "r",
          provider: "openai",
          model: "m",
          apiKey: "a",
          apiKeys: ["b", "c"],
        },
      ],
    });
    // Pool assembly is the engine's job; here both survive validation.
    expect(cfg.routes[0]!.apiKey).toBe("a");
    expect(cfg.routes[0]!.apiKeys).toEqual(["b", "c"]);
  });

  test("rejects non-object input", () => {
    expect(() => parseConfig(null)).toThrow(ConfigError);
    expect(() => parseConfig([1])).toThrow(ConfigError);
  });

  test("rejects empty or missing routes", () => {
    expect(() => parseConfig({})).toThrow(/routes/);
    expect(() => parseConfig({ routes: [] })).toThrow(/must not be empty/);
  });

  test("rejects duplicate route ids", () => {
    expect(() =>
      parseConfig({
        routes: [
          { id: "x", provider: "openai", model: "m", apiKey: "k" },
          { id: "x", provider: "openai", model: "m", apiKey: "k" },
        ],
      }),
    ).toThrow(/duplicate route id/);
  });

  test("rejects unknown providers with the known list", () => {
    expect(() =>
      parseConfig({ routes: [{ id: "x", provider: "cohere", model: "m", apiKey: "k" }] }),
    ).toThrow(/unknown provider/);
  });

  test("requires baseUrl for openai-compatible", () => {
    expect(() =>
      parseConfig({
        routes: [{ id: "x", provider: "openai-compatible", model: "m", apiKey: "k" }],
      }),
    ).toThrow(/baseUrl/);
  });

  test("requires at least one key", () => {
    expect(() =>
      parseConfig({ routes: [{ id: "x", provider: "openai", model: "m" }] }),
    ).toThrow(/apiKey/);
  });

  test("rejects empty apiKeys arrays and non-string entries", () => {
    const route = (apiKeys: unknown) => ({
      routes: [{ id: "x", provider: "openai", model: "m", apiKeys }],
    });
    expect(() => parseConfig(route([]))).toThrow(/apiKeys/);
    expect(() => parseConfig(route(["ok", ""]))).toThrow(/apiKeys/);
    expect(() => parseConfig(route([42]))).toThrow(/apiKeys/);
  });

  test("validates limit values", () => {
    const route = (limit: unknown) => ({
      routes: [{ id: "x", provider: "openai", model: "m", apiKey: "k", limit }],
    });
    expect(() => parseConfig(route({ rpm: 0 }))).toThrow(/rpm/);
    expect(() => parseConfig(route({ tpm: -5 }))).toThrow(/tpm/);
    expect(() => parseConfig(route({ rpm: 1.5 }))).toThrow(/rpm/);
    expect(parseConfig(route({ rpm: 10, tpm: 1000 })).routes[0]!.limit).toEqual({
      rpm: 10,
      tpm: 1000,
    });
  });

  test("aggregates multiple violations in one error", () => {
    try {
      parseConfig({
        routes: [
          { id: "", provider: "openai", model: "m", apiKey: "k" },
          { id: "b", provider: "nope", model: "m", apiKey: "k" },
        ],
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/routes\[0\]\.id/);
      expect((err as Error).message).toMatch(/routes\[1\]\.provider/);
    }
  });
});
