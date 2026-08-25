/**
 * Shared wire DTOs between the API routes and the browser UI.
 * Types-only module — safe to import from client components.
 */
import type { AttemptEvent } from "@ai-router/core";

export type { AttemptEvent };

/** Telemetry strip under an assistant bubble. */
export interface Stats {
  provider?: string;
  model?: string;
  ttftMs: number;
  totalMs: number;
  tokens: number;
  tps: number;
}

/** One NDJSON line of the POST /api/chat response stream. */
export type ChatFrame =
  | ({ type: "event" } & AttemptEvent)
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
