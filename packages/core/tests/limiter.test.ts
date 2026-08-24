import { describe, expect, test } from "vitest";
import { MemoryStore } from "../src/limiter/memory.js";

describe("MemoryStore", () => {
  test("allows up to the limit within the window, then blocks", async () => {
    let t = 0;
    const store = new MemoryStore({ now: () => t });

    expect((await store.take("k", 1, 60_000, 2)).allowed).toBe(true);
    expect((await store.take("k", 1, 60_000, 2)).allowed).toBe(true);
    const blocked = await store.take("k", 1, 60_000, 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("frees capacity once entries age out of the window", async () => {
    let t = 0;
    const store = new MemoryStore({ now: () => t });

    await store.take("k", 1, 60_000, 1);
    expect((await store.take("k", 1, 60_000, 1)).allowed).toBe(false);

    t = 60_001;
    expect((await store.take("k", 1, 60_000, 1)).allowed).toBe(true);
  });

  test("keys are isolated", async () => {
    const store = new MemoryStore({ now: () => 0 });
    await store.take("a", 1, 60_000, 1);
    expect((await store.take("a", 1, 60_000, 1)).allowed).toBe(false);
    expect((await store.take("b", 1, 60_000, 1)).allowed).toBe(true);
  });

  test("weighted costs accumulate", async () => {
    let t = 0;
    const store = new MemoryStore({ now: () => t });

    expect((await store.take("tpm", 400, 60_000, 1000)).allowed).toBe(true);
    expect((await store.take("tpm", 400, 60_000, 1000)).allowed).toBe(true);
    expect((await store.take("tpm", 400, 60_000, 1000)).allowed).toBe(false);
  });

  test("record() adds usage without gating; later takes see it", async () => {
    let t = 0;
    const store = new MemoryStore({ now: () => t });

    await store.record("tpm", 900, 60_000);
    expect((await store.take("tpm", 200, 60_000, 1000)).allowed).toBe(false);
  });
});
