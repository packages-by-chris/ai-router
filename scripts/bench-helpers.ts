import type { NormalizedRoute } from "../packages/core/src/providers/types.js";

/**
 * Build a NormalizedRoute for benchmarks (bypasses the engine's private
 * normalizeRoute; only the fields adapters read are populated).
 */
export function normalizeRouteForBench(route: {
  id: string;
  provider: string;
  model: string;
  apiKey: string;
}): NormalizedRoute {
  return {
    ...route,
    adapterId: "openai",
    keyPool: [route.apiKey],
    headers: {},
    maxRetries: 0,
    timeoutMs: 30_000,
    limits: {},
  };
}
