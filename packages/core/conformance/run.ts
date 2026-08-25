/**
 * Conformance runner. Executes JSON fixture cases against the TS
 * implementation. The Python SDK must run these same fixtures against its
 * own implementation — that is the drift guard for the multi-language
 * contract (see /conformance/README.md).
 *
 * The reusable core lives in src/conformance/cases.ts and is exported from
 * the package so third-party adapter authors can run the same fixture
 * format against their own translations.
 *
 * Run: npm run conformance (or: npx tsx conformance/run.ts)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runTranslationCase,
  type TranslationHandlers,
} from "../src/conformance/cases.js";
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

const handlers: TranslationHandlers = {
  openai_request: ({ request, providerModel, stream }) =>
    translateOpenAI(request!, providerModel, stream),
  openai_response: ({ response, providerModel }) =>
    translateOpenAIResponse(response, providerModel),
  anthropic_request: ({ request, providerModel, stream }) =>
    translateAnthropic(request!, providerModel, stream),
  anthropic_response: ({ response, providerModel }) =>
    translateAnthropicResponse(response, providerModel),
  gemini_request: ({ request, providerModel, stream }) =>
    translateGemini(request!, providerModel, stream),
  gemini_response: ({ response, providerModel }) =>
    translateGeminiResponse(response, providerModel),
};

const casesDir = join(import.meta.dirname!, "cases");
let total = 0;
let failed = 0;

for (const file of readdirSync(casesDir).filter((f) => f.endsWith(".json"))) {
  const suite = JSON.parse(readFileSync(join(casesDir, file), "utf8")) as {
    cases: Parameters<typeof runTranslationCase>[0][];
  };
  for (const c of suite.cases) {
    total++;
    const result = runTranslationCase(c, handlers);
    if (result.ok) {
      console.log(`  ok   ${file} :: ${c.name}`);
    } else {
      failed++;
      console.log(`  FAIL ${file} :: ${c.name}`);
      console.log(`    expected: ${result.expected}`);
      console.log(`    actual:   ${result.actual}`);
    }
  }
}

console.log(`\n${total - failed}/${total} conformance cases pass`);
process.exit(failed > 0 ? 1 : 0);
