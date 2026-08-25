/**
 * Conformance kit: the reusable core of the fixture runner. Third-party
 * adapter packages (`registerAdapter`) import `runTranslationCases` from
 * this module to prove their request/response translation against the same
 * JSON case format the built-in adapters and the Python SDK use — the
 * cross-SDK drift guard, available to the ecosystem.
 *
 * Case JSON shape (see conformance/cases/*.json):
 *   { name, kind, providerModel, stream?, request?, response?, expected }
 */

import type { ChatRequest } from "../types.js";

export type CaseKind =
  | "openai_request"
  | "openai_response"
  | "anthropic_request"
  | "anthropic_response"
  | "gemini_request"
  | "gemini_response"
  | (string & {});

export interface TranslationCase {
  name: string;
  kind: CaseKind;
  providerModel: string;
  stream?: boolean;
  request?: ChatRequest;
  response?: unknown;
  expected: unknown;
}

/**
 * Handlers map case kinds to translation functions. Built-ins cover the
 * shipped adapters; register extra kinds for custom adapters.
 */
export type TranslationHandlers = Record<
  string,
  (input: { request?: ChatRequest; response?: unknown; providerModel: string; stream: boolean }) => unknown
>;

export const BUILTIN_TRANSLATION_HANDLERS: TranslationHandlers = {};

/** Deterministic JSON for diffing (sorted keys, no whitespace). */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface CaseResult {
  name: string;
  ok: boolean;
  expected?: string;
  actual?: string;
}

/** Run one translation case. Never throws; returns a diff-ready result. */
export function runTranslationCase(
  c: TranslationCase,
  handlers: TranslationHandlers = BUILTIN_TRANSLATION_HANDLERS,
): CaseResult {
  const handler = handlers[c.kind];
  if (!handler) {
    return {
      name: c.name,
      ok: false,
      expected: "a registered translation handler",
      actual: `no handler for kind "${c.kind}"`,
    };
  }
  const actual = handler({
    request: c.request,
    response: c.response,
    providerModel: c.providerModel,
    stream: c.stream === true,
  });
  const ok = stable(actual) === stable(c.expected);
  return ok
    ? { name: c.name, ok }
    : { name: c.name, ok, expected: stable(c.expected), actual: stable(actual) };
}

/** Run a whole suite (one parsed JSON file's `cases` array). */
export function runTranslationCases(
  cases: TranslationCase[],
  handlers: TranslationHandlers = BUILTIN_TRANSLATION_HANDLERS,
): { total: number; failed: number; results: CaseResult[] } {
  const results = cases.map((c) => runTranslationCase(c, handlers));
  return {
    total: results.length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
