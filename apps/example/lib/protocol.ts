/**
 * Shared wire DTOs between the API routes and the browser UI.
 * Types-only module — safe to import from client components.
 */
import type { AttemptEvent, RoutingExplanation, RouterStats } from "@ai-router/core";

export type { AttemptEvent, RoutingExplanation, RouterStats };

/** Telemetry strip under an assistant bubble. */
export interface Stats {
  routeId?: string;
  provider?: string;
  model?: string;
  ttftMs: number;
  totalMs: number;
  tokens: number;
  tps: number;
  costUsd?: number;
}

/** One NDJSON line of the POST /api/chat response stream. */
export type ChatFrame =
  | ({ type: "event" } & AttemptEvent)
  | ({ type: "plan" } & RoutingExplanation)
  | { type: "delta"; text: string }
  | ({ type: "stats" } & Stats)
  | { type: "done"; finish: string | null }
  | { type: "error"; message: string };

/** One entry of the POST /api/test-chain response. */
export interface TestResult {
  id: string;
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  sample?: string;
  error?: string;
}
