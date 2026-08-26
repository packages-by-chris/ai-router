import { describe, expect, test } from "vitest";
import { RedisStateStore, STATE_GET_SCRIPT, STATE_SET_SCRIPT } from "../src/state.js";
import type { RedisEvalClient } from "../src/store.js";

/** In-memory GET/SET behind the eval surface; records calls for assertions. */
class FakeStateRedis implements RedisEvalClient {
  readonly data = new Map<string, string>();
  readonly calls: { script: string; keys: string[]; args: (string | number)[] }[] = [];
  constructor(private readonly fail = false) {}
  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    this.calls.push({ script, keys, args });
    if (this.fail) throw new Error("REDIS_DOWN");
    if (script === STATE_GET_SCRIPT) return this.data.get(keys[0]!) ?? null;
    if (script === STATE_SET_SCRIPT) {
      this.data.set(keys[0]!, String(args[0]!));
      return 1;
    }
    throw new Error(`unknown script: ${script.slice(0, 40)}`);
  }
}

describe("RedisStateStore", () => {
  test("set writes namespaced key with PX ttl; get round-trips", async () => {
    const client = new FakeStateRedis();
    const store = new RedisStateStore({ client, prefix: "ns:" });
    await store.set("state:v1", '{"savedAt":1}', 60_000);
    const call = client.calls.find((c) => c.script === STATE_SET_SCRIPT)!;
    expect(call.keys[0]).toBe("ns:state:v1");
    expect(call.args[0]).toBe('{"savedAt":1}');
    expect(Number(call.args[1])).toBe(60_000);
    expect(await store.get("state:v1")).toBe('{"savedAt":1}');
  });

  test("get returns null for missing keys and on redis failure (fail open)", async () => {
    const missing = new RedisStateStore({ client: new FakeStateRedis() });
    expect(await missing.get("nope")).toBeNull();

    const down = new RedisStateStore({ client: new FakeStateRedis(true) });
    expect(await down.get("k")).toBeNull();
    await expect(down.set("k", "v", 1000)).resolves.toBeUndefined(); // swallowed
  });

  test("end-to-end with RoutingEngine stateStore option", async () => {
    const { RoutingEngine, parseConfig } = await import("@ai-router/core");
    const client = new FakeStateRedis();
    const store = new RedisStateStore({ client });
    const cfg = parseConfig({
      routes: [
        { id: "a", provider: "openai", model: "ma", apiKey: "ka", maxRetries: 0 },
        { id: "b", provider: "openai-compatible", baseUrl: "https://b.test/v1", model: "mb", apiKey: "kb", maxRetries: 0 },
      ],
    });
    const ok = async () =>
      new Response(JSON.stringify({
        id: "x", object: "chat.completion", created: 1, model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });

    const a = new RoutingEngine(cfg, { fetchImpl: ok, sleep: async () => {}, stateStore: store });
    await a.complete({ model: "a", messages: [{ role: "user", content: "hi" }] });
    await a.flushState();
    expect(client.data.size).toBe(1);

    const b = new RoutingEngine(cfg, { fetchImpl: ok, sleep: async () => {}, stateStore: store });
    await b.ready();
    const stats = await b.stats();
    expect(stats.health.find((h) => h.routeId === "a")?.successes).toBe(1);
  });
});
