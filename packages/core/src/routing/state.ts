/**
 * Optional persistence for learned routing state (health, outcomes, circuit
 * breakers). Implement over Redis/Postgres/anything; inject via
 * `EngineOptions.stateStore`. Without it, all learning stays in-process and
 * dies with the engine instance.
 *
 * Semantics are deliberately simple: namespaced JSON snapshots written
 * behind-the-scenes after mutations (debounced), loaded once at startup.
 * Last-writer-wins per snapshot — replicas converge on fresh-enough data,
 * not linearizable truth. Failures to read/write never break routing.
 */

export interface RouterStateStore {
  get(key: string): Promise<string | null | undefined> | string | null | undefined;
  set(key: string, value: string, ttlMs: number): Promise<void> | void;
}

/** Default key under which the engine persists its combined snapshot. */
export const DEFAULT_STATE_KEY = "ai-router:state:v1";

/**
 * Cheap request-shape classifier for workload-aware routing. Produces the
 * `task` bucket used by quality-first ordering when the caller does not
 * name one (`routing.task`). Heuristic, deterministic, no ML: buckets map
 * to routing-relevant workload shapes, not semantics.
 *
 * `estimatedInputTokens` comes from the caller (engine passes its own
 * `estimateTokens` result) to keep this module dependency-free.
 */
import type { ChatRequest } from "../types.js";

export function inferTask(req: ChatRequest, estimatedInputTokens?: number): string {
  if (req.tools && req.tools.length > 0) return "tool-use";
  for (const msg of req.messages) {
    if (Array.isArray(msg.content) && msg.content.some((p) => p.type === "image_url")) {
      return "vision";
    }
  }
  if (req.response_format?.type === "json_schema" || req.response_format?.type === "json_object") {
    return "structured";
  }
  if (req.reasoning_effort !== undefined) return "reasoning";
  const tokens = estimatedInputTokens ?? roughTokens(req);
  if (tokens > 8_000) return "long-context";
  return "chat";
}

/** Fallback char heuristic (~3.5 chars/token) matching engine.estimateTokens closely enough. */
function roughTokens(req: ChatRequest): number {
  let chars = 0;
  for (const msg of req.messages) {
    if (typeof msg.content === "string") chars += msg.content.length;
    else if (Array.isArray(msg.content)) chars += msg.content.length;
  }
  return Math.ceil(chars / 3.5) + 1;
}
