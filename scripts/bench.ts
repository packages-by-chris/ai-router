/**
 * Routing-overhead benchmark.
 *
 * Measures what ai-router ADDS on top of a raw provider call, using an
 * in-memory mock fetch (so numbers isolate routing machinery — config
 * parsing, candidate gating, key rotation, limiter bookkeeping,
 * response translation is shared by both sides).
 *
 *   direct adapter call  = OpenAIAdapter.complete() with the same mock fetch
 *   router.complete()    = full engine pipeline, single route, no retries
 *
 * Run: npm run bench
 * Offline by design; results are environment-dependent — do not quote them
 * as product claims without re-measuring on target hardware.
 */

import { parseConfig } from "../packages/core/src/config/parse.js";
import { RoutingEngine } from "../packages/core/src/engine.js";
import { OpenAIAdapter } from "../packages/core/src/providers/openai.js";
import { normalizeRouteForBench } from "./bench-helpers.js";

const ITERATIONS = Number(process.env.BENCH_ITERS ?? 20_000);
const WARMUP = 2_000;

const completion = {
  id: "chatcmpl-bench",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "bench-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
};

const mockFetch = async (_url: string, _init?: RequestInit) =>
  new Response(JSON.stringify(completion), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const req = { model: "main", messages: [{ role: "user" as const, content: "hello world" }] };

const adapter = new OpenAIAdapter();
const normalizedRoute = normalizeRouteForBench({
  id: "main",
  provider: "openai",
  model: "bench-model",
  apiKey: "bench-key",
});

const engine = new RoutingEngine(
  parseConfig({
    routes: [{ id: "main", provider: "openai", model: "bench-model", apiKey: "bench-key" }],
  }),
  { fetchImpl: mockFetch },
);

function percentiles(samples: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

async function bench(name: string, op: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < WARMUP; i++) await op();
  const samples: number[] = new Array(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await op();
    samples[i] = performance.now() - t0;
  }
  const { p50, p95, p99 } = percentiles(samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(
    `${name.padEnd(28)} p50 ${p50.toFixed(3)}ms  p95 ${p95.toFixed(3)}ms  p99 ${p99.toFixed(3)}ms  mean ${mean.toFixed(3)}ms`,
  );
}

async function main(): Promise<void> {
  console.log(`\nai-router overhead benchmark — ${ITERATIONS} iterations, mock fetch\n`);

  await bench("direct adapter.complete()", () =>
    adapter.complete(normalizedRoute, "bench-key", req, { fetchImpl: mockFetch }),
  );
  await bench("router.complete() [fallback]", () => engine.complete(req));

  // Overhead summary: rerun both interleaved to reduce drift.
  let directTotal = 0;
  let routedTotal = 0;
  for (let i = 0; i < ITERATIONS / 2; i++) {
    let t0 = performance.now();
    await adapter.complete(normalizedRoute, "bench-key", req, { fetchImpl: mockFetch });
    directTotal += performance.now() - t0;

    t0 = performance.now();
    await engine.complete(req);
    routedTotal += performance.now() - t0;
  }
  const perCallOverheadUsd = ((routedTotal - directTotal) / (ITERATIONS / 2)) * 1000;
  console.log(
    `\nmean overhead vs direct call: ${perCallOverheadUsd >= 0 ? "+" : ""}${perCallOverheadUsd.toFixed(1)}µs/request`,
  );
  console.log("(mock fetch isolates routing cost; real-world overhead is dominated by the network)\n");
}

void main();
