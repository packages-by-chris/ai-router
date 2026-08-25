/**
 * Guardrails: request/response validation hooks that can veto or rewrite
 * traffic before it leaves (input) or before it reaches the caller (output).
 *
 * Semantics:
 * - Input guardrails run ONCE per logical call, before routing — a blocked
 *   input never hits any provider, never consumes rate-limit budget.
 * - Output guardrails run after a successful complete() result
 *   (post spend-recording: the provider charged regardless). A blocked
 *   output throws — it does NOT fall back to the next route (the same
 *   prompt would produce a similar output). Embed responses skip output
 *   guards.
 * - Streams: input guardrails apply; output guardrails are skipped for
 *   streams by design — scanning requires buffering, which would defeat
 *   streaming's purpose.
 * - raw() bypasses everything by contract.
 */

import { AIRouterError } from "./errors.js";
import type { ChatRequest, ChatResponse } from "./types.js";

export interface GuardrailVerdict {
  /** false blocks the call with GuardrailBlockedError. Default true. */
  pass?: boolean;
  /** Human-readable block reason (surfaced on the error). */
  reason?: string;
  /**
   * Replace the value flowing through: the ChatRequest for input phase,
   * the ChatResponse for output phase. Enables redaction/rewriting guards.
   */
  replace?: unknown;
}

/** Validates/transforms requests before routing. */
export interface InputGuardrail {
  readonly name?: string;
  check(req: ChatRequest): GuardrailVerdict | Promise<GuardrailVerdict>;
}

/** Validates/transforms responses after a provider succeeds. */
export interface OutputGuardrail {
  readonly name?: string;
  check(res: ChatResponse): GuardrailVerdict | Promise<GuardrailVerdict>;
}

export interface Guardrails {
  input?: InputGuardrail[];
  output?: OutputGuardrail[];
}

export class GuardrailBlockedError extends AIRouterError {
  readonly phase: "input" | "output";
  readonly guardrail: string;
  readonly reason?: string;

  constructor(phase: "input" | "output", guardrail: string, reason?: string) {
    super(
      `guardrail "${guardrail}" blocked ${phase}` + (reason ? `: ${reason}` : ""),
    );
    this.phase = phase;
    this.guardrail = guardrail;
    this.reason = reason;
  }
}

/**
 * Run one guardrail phase. Returns the (possibly replaced) value; throws
 * GuardrailBlockedError when a guardrail fails. Never swallows errors from
 * misbehaving guards — a broken guardrail is a caller bug worth surfacing.
 */
export async function runGuardrails<T>(
  phase: "input" | "output",
  guards: Array<{ readonly name?: string; check(value: T): GuardrailVerdict | Promise<GuardrailVerdict> }> | undefined,
  value: T,
): Promise<T> {
  if (!guards || guards.length === 0) return value;
  let current = value;
  for (const guard of guards) {
    const verdict = await guard.check(current);
    if (verdict?.pass === false) {
      throw new GuardrailBlockedError(phase, guard.name ?? `guardrails[${guards.indexOf(guard)}]`, verdict.reason);
    }
    if (verdict?.replace !== undefined && verdict.replace !== null) {
      current = verdict.replace as T;
    }
  }
  return current;
}
