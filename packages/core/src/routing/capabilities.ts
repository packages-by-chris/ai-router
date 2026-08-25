/**
 * Capability-aware routing metadata.
 *
 * Routes may declare what their model supports (`capabilities` in config).
 * Requirements reach the router two ways, with different failure semantics:
 *
 *   1. Explicit requirements (`routing.require`) are HARD constraints: a
 *      candidate must declare the capability true, otherwise it is
 *      eliminated — including candidates with NO declared profile (an
 *      explicit demand is not satisfied by an unknown).
 *   2. Request-inferred requirements (request carries tools → needs tools,
 *      image parts → vision, json_schema → structuredOutput,
 *      reasoning_effort → reasoning, stream()/embed() → their flags) are
 *      METADATA-DRIVEN: only candidates that DECLARE a conflicting profile
 *      are eliminated. Undeclared routes stay eligible so existing configs
 *      never change behavior.
 *
 * `contextWindow`, when declared, eliminates candidates whose estimated
 * input tokens exceed it.
 */

import type { ChatRequest } from "../types.js";

/** Declared per-route capability profile. */
export interface ModelCapabilities {
  streaming?: boolean;
  tools?: boolean;
  vision?: boolean;
  /** Accepts response_format: { type: "json_object" }. */
  json?: boolean;
  /** Accepts schema-constrained output (response_format json_schema or equivalent). */
  structuredOutput?: boolean;
  /** Handles reasoning_effort hints. */
  reasoning?: boolean;
  audio?: boolean;
  embeddings?: boolean;
  multimodal?: boolean;
  longContext?: boolean;
  /** Max prompt tokens the route accepts; requests above it are eliminated. */
  contextWindow?: number;
}

/** Explicit per-call requirements (`routing.require`). true = must support. */
export type CapabilityRequirement = Partial<Record<keyof ModelCapabilities, boolean>>;

/** Which engine operation a candidate is being evaluated for. */
export type RouteOp = "complete" | "stream" | "embed";

const BOOLEAN_CAPS = [
  "streaming", "tools", "vision", "json", "structuredOutput",
  "reasoning", "audio", "embeddings", "multimodal", "longContext",
] as const satisfies readonly (keyof ModelCapabilities)[];

/**
 * Requirements implied by the logical request itself.
 */
export function inferredRequirements(req: ChatRequest, op: RouteOp): CapabilityRequirement {
  const need: CapabilityRequirement = {};
  if (op === "stream") need.streaming = true;
  if (op === "embed") need.embeddings = true;
  if (req.tools && req.tools.length > 0) need.tools = true;
  for (const msg of req.messages) {
    if (Array.isArray(msg.content) && msg.content.some((p) => p.type === "image_url")) {
      need.vision = true;
      break;
    }
  }
  if (req.response_format?.type === "json_object") need.json = true;
  if (req.response_format?.type === "json_schema") need.structuredOutput = true;
  if (req.reasoning_effort !== undefined) need.reasoning = true;
  return need;
}

/**
 * Rejection reason when a candidate cannot serve this request, or null when
 * eligible. See the module docs for hard-vs-metadata semantics.
 *
 * `estimatedInputTokens` gates `contextWindow` when declared.
 */
export function capabilityRejection(
  caps: ModelCapabilities | undefined,
  req: ChatRequest,
  op: RouteOp,
  require: CapabilityRequirement | undefined,
  estimatedInputTokens?: number,
): string | null {
  const inferred = inferredRequirements(req, op);

  // Hard constraints first: explicit demands beat declarations' absence.
  if (require) {
    for (const key of BOOLEAN_CAPS) {
      if (require[key] === true && caps?.[key] !== true) {
        return `requires ${key} but route does not declare it`;
      }
    }
  }

  // Metadata-driven inference: only declared profiles can conflict.
  if (caps) {
    for (const key of BOOLEAN_CAPS) {
      if (inferred[key] === true && caps[key] !== true) {
        return `request needs ${key} but route does not declare it`;
      }
    }
    if (
      caps.contextWindow !== undefined &&
      estimatedInputTokens !== undefined &&
      estimatedInputTokens > caps.contextWindow
    ) {
      return `estimated ${estimatedInputTokens} input tokens exceeds contextWindow ${caps.contextWindow}`;
    }
  }

  return null;
}
