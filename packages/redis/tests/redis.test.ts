import { describe, expect, test } from "bun:test";
import { MemoryStore } from "@ai-router/core";
import {
  RedisStore,
  RECORD_SCRIPT,
  TAKE_SCRIPT,
  ioredisClient,
  nodeRedisClient,
  type RedisEvalClient,
} from "../src/store.js";

/**
 * No Redis server in this environment. Two test layers instead:
 *
 * 1. FakeRedis — executes the same sliding-window semantics in JS (backed by
 *    MemoryStore) behind the eval() surface. Proves plumbing: arg order, key
 *    namespacing, result parsing, end-to-end behavior parity.
 * 2. Scripted mocks — fail-open/fail-closed and adapter shapes.
 *
 * The Lua scripts themselves need a real Redis; run packages/redis/integration
 * in CI (see README).
 */

class FakeRedis implements RedisEvalClient {
  private readonly mem = new MemoryStore();
  /** Records every eval call for assertions. */
  readonly calls: { script: string; keys: string[]; args: (string | number)[] }[] = [];

  constructor(private readonly fail = false) {}

  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    this.calls.push({ script, keys, args });
    if (this.fail) throw new Error("REDIS_DOWN");
    if (script === TAKE_SCRIPT) {
      const [cost, windowMs, limit] = args;
      const decision = await this.mem.take(keys[0]!, Number(cost), Number(windowMs), Number(limit));
      return [decision.allowed ? 1 : 0, decision.retryAfterMs];
    }
    if (script === RECORD_SCRIPT) {
      await this.mem.record(keys[0]!, Number(args[0]!), Number(args[1]!));
      return 1;
    }
    throw new Error(`unknown script: ${script.slice(0, 40)}`);
  }
}

describe("RedisStore.take", () => {
  test("enforces the limit across sequential takes (shared-state semantics)", async () => {
    const client = new FakeRedis();
    const store = new RedisStore({ client });

    expect((await store.take("a:rpm", 1, 60_000, 2)).allowed).toBe(true);
    expect((await store.take("a:rpm", 1, 60_000, 2)).allowed).toBe(true);
    const blocked = await store.take("a:rpm", 1, 60_000, 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("weighted costs accumulate like the in-process store", async () => {
    const store = new RedisStore({ client: new FakeRedis() });
    expect((await store.take("tpm", 400, 60_000, 1000)).allowed).toBe(true);
    expect((await store.take("tpm", 400, 60_000, 1000)).allowed).toBe(true);
    expect((await store.take("tpm", 400, 60_000, 1000)).allowed).toBe(false);
  });

  test("record() adds usage that later takes see", async () => {
    const store = new RedisStore({ client: new FakeRedis() });
    await store.record("tpm", 900, 60_000);
    expect((await store.take("tpm", 200, 60_000, 1000)).allowed).toBe(false);
  });

  test("namespaces keys and passes cost/window/limit/now/member as args", async () => {
    let t = 1_000_000;
    const client = new FakeRedis();
    const store = new RedisStore({ client, prefix: "myapp:", now: () => t });

    await store.take("a:rpm", 1, 60_000, 60);
    const call = client.calls[0]!;
    expect(call.keys).toEqual(["myapp:a:rpm"]);
    expect(call.args.slice(0, 4)).toEqual([1, 60_000, 60, 1_000_000]);
    const member = String(call.args[4]);
    // member format "<now>:<seq>:<rand>:<cost>" — cost anchored last so the
    // Lua side can parse it with ':(%d+)$'
    expect(member).toMatch(/^\d+:\d+:[a-z0-9]+:1$/);
    expect(member.startsWith("1000000:")).toBe(true);
  });

  test("member uniqueness across calls (ZADD would overwrite duplicates)", async () => {
    const client = new FakeRedis();
    const store = new RedisStore({ client, now: () => 5_000 }); // frozen clock
    await store.take("k", 1, 60_000, 10);
    await store.take("k", 1, 60_000, 10);
    await store.record("k", 3, 60_000);
    const members = client.calls.map((c) => String(c.args[4]));
    expect(members[0]).not.toBe(members[1]);
    expect(members[1]).not.toBe(members[2]);
  });
});

describe("RedisStore failure handling", () => {
  test("fail-open (default): allows on client error and reports via onError", async () => {
    const errors: unknown[] = [];
    const store = new RedisStore({ client: new FakeRedis(true), onError: (e) => errors.push(e) });

    const decision = await store.take("a:rpm", 1, 60_000, 1);
    expect(decision.allowed).toBe(true);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("REDIS_DOWN");

    await store.record("tpm", 100, 60_000); // must not throw
    expect(errors).toHaveLength(2);
  });

  test("fail-closed: blocks on client error; record() throws", async () => {
    const store = new RedisStore({ client: new FakeRedis(true), failOpen: false });

    expect((await store.take("a:rpm", 1, 60_000, 1)).allowed).toBe(false);
    await expect(store.record("tpm", 100, 60_000)).rejects.toThrow("REDIS_DOWN");
  });
});

describe("client adapters", () => {
  test("ioredisClient spreads numKeys + keys + args", async () => {
    const calls: unknown[][] = [];
    const fake = {
      eval(script: string, numKeys: number, ...rest: unknown[]) {
        calls.push([script, numKeys, ...rest]);
        return Promise.resolve([1, 0]);
      },
    };
    const store = new RedisStore({ client: ioredisClient(fake) });
    const decision = await store.take("k", 2, 60_000, 10);

    expect(decision).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(calls[0]![1]).toBe(1); // numKeys
    expect(calls[0]![2]).toBe("ai-router:k"); // first key
  });

  test("nodeRedisClient passes { keys, arguments }", async () => {
    const calls: { script: string; opts: { keys: string[]; arguments: unknown[] } }[] = [];
    const fake = {
      eval(script: string, opts: { keys: string[]; arguments: unknown[] }) {
        calls.push({ script, opts });
        return Promise.resolve([0, 250]);
      },
    };
    const store = new RedisStore({ client: nodeRedisClient(fake) });
    const decision = await store.take("k", 2, 60_000, 10);

    expect(decision).toEqual({ allowed: false, retryAfterMs: 250 });
    expect(calls[0]!.opts.keys).toEqual(["ai-router:k"]);
    expect(calls[0]!.opts.arguments[0]).toBe(2);
  });
});

describe("result parsing", () => {
  test("string-typed returns coerce (cluster/proxy clients)", async () => {
    const store = new RedisStore({
      client: {
        async eval() {
          return ["0", "750"];
        },
      },
    });
    const decision = await store.take("k", 1, 60_000, 1);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(750);
  });

  test("malformed returns fail closed on the decision, not the call", async () => {
    const store = new RedisStore({ client: { async eval() { return null; } } });
    expect((await store.take("k", 1, 60_000, 1)).allowed).toBe(false);
  });
});
