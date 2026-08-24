/**
 * Conformance runner. Executes JSON fixture cases against the TS
 * implementation. The Python SDK must run these same fixtures against its
 * own implementation — that is the drift guard for the multi-language
 * contract (see /conformance/README.md).
 *
 * Case kinds:
 *   - openai_request:    unified request      -> OpenAI body
 *   - anthropic_request: unified request      -> Anthropic body
 *   - anthropic_response: Anthropic message   -> unified response
 *
 * Run: npm run conformance (or: npx tsx conformance/run.ts)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  translateRequest as translateOpenAI,
  translateResponse as translateOpenAIResponse,
} from "../src/providers/openai.js";
import {
  translateRequest as translateAnthropic,
  translateResponse as translateAnthropicResponse,
} from "../src/providers/anthropic.js";
import {
  translateRequest as translateGemini,
  translateResponse as translateGeminiResponse,
} from "../src/providers/gemini.js";
import type { ChatRequest } from "../src/types.js";

type CaseKind =
  | "openai_request"
  | "openai_response"
  | "anthropic_request"
  | "anthropic_response"
  | "gemini_request"
  | "gemini_response";

interface Case {
  name: string;
  kind: CaseKind;
  providerModel: string;
  stream?: boolean;
  request?: ChatRequest;
  response?: unknown;
  expected: unknown;
}

/** Deterministic JSON for diffing (sorted keys, no whitespace). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function actualFor(c: Case): unknown {
  switch (c.kind) {
    case "openai_request":
      return translateOpenAI(c.request!, c.providerModel, c.stream === true);
    case "openai_response":
      return translateOpenAIResponse(c.response, c.providerModel);
    case "anthropic_request":
      return translateAnthropic(c.request!, c.providerModel, c.stream === true);
    case "anthropic_response":
      return translateAnthropicResponse(c.response, c.providerModel);
    case "gemini_request":
      return translateGemini(c.request!, c.providerModel, c.stream === true);
    case "gemini_response":
      return translateGeminiResponse(c.response, c.providerModel);
  }
}

const casesDir = join(import.meta.dirname!, "cases");
let total = 0;
let failed = 0;

for (const file of readdirSync(casesDir).filter((f) => f.endsWith(".json"))) {
  const suite = JSON.parse(readFileSync(join(casesDir, file), "utf8")) as { cases: Case[] };
  for (const c of suite.cases) {
    total++;
    const ok = stable(actualFor(c)) === stable(c.expected);
    if (ok) {
      console.log(`  ok   ${file} :: ${c.name}`);
    } else {
      failed++;
      console.log(`  FAIL ${file} :: ${c.name}`);
      console.log(`    expected: ${stable(c.expected)}`);
      console.log(`    actual:   ${stable(actualFor(c))}`);
    }
  }
}

console.log(`\n${total - failed}/${total} conformance cases pass`);
process.exit(failed > 0 ? 1 : 0);
