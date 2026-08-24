/**
 * Live smoke test against real provider APIs. Run manually with keys:
 *
 *   OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=... npx tsx scripts/smoke.ts
 *
 * Per provider with a key present: one tiny non-streaming completion and one
 * tiny streaming request through the full unified pipeline (translation,
 * engine, SSE parsing). Asserts response shape, not content.
 *
 * Cheap by design: haiku/flash/mini-class models, max_tokens ~16.
 */

import { AIRouter } from "../packages/core/src/index.js";
import type { ChatRequest } from "../packages/core/src/index.js";

interface Target {
  provider: string;
  envKey: string;
  route: Record<string, unknown>;
}

const TARGETS: Target[] = [
  {
    provider: "openai",
    envKey: "OPENAI_API_KEY",
    route: { id: "smoke", provider: "openai", model: "gpt-4o-mini", maxRetries: 0 },
  },
  {
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    route: { id: "smoke", provider: "anthropic", model: "claude-haiku-4-5", maxRetries: 0 },
  },
  {
    provider: "gemini",
    envKey: "GEMINI_API_KEY",
    route: { id: "smoke", provider: "gemini", model: "gemini-2.0-flash", maxRetries: 0 },
  },
];

const req: ChatRequest = {
  model: "smoke",
  messages: [{ role: "user", content: "Reply with exactly: ok" }],
};

async function smokeComplete(router: AIRouter): Promise<string> {
  const res = await router.complete({ ...req, max_tokens: 16 });
  const text = res.choices[0]?.message.content;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error(`empty completion content (finish=${res.choices[0]?.finish_reason})`);
  }
  return `${JSON.stringify(text.slice(0, 40))} usage=${res.usage?.total_tokens ?? "?"}tok`;
}

async function smokeStream(router: AIRouter): Promise<string> {
  const stream = await router.stream({ ...req, max_tokens: 16 });
  let chunks = 0;
  let finish: string | null = null;
  let text = "";
  for await (const chunk of stream) {
    chunks++;
    if (chunk.delta.content) text += chunk.delta.content;
    if (chunk.finish_reason) finish = chunk.finish_reason;
  }
  if (chunks === 0) throw new Error("no chunks received");
  return `${chunks} chunks, finish=${finish}, text=${JSON.stringify(text.slice(0, 40))}`;
}

let failures = 0;
let ran = 0;

for (const target of TARGETS) {
  const key = process.env[target.envKey];
  if (!key) {
    console.log(`skip ${target.provider} (${target.envKey} not set)`);
    continue;
  }
  ran++;
  const router = new AIRouter({
    routes: [{ ...target.route, apiKey: key } as never],
  });

  try {
    const completeInfo = await smokeComplete(router);
    console.log(`PASS ${target.provider} complete: ${completeInfo}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${target.provider} complete: ${(err as Error).message}`);
    continue;
  }

  try {
    const streamInfo = await smokeStream(router);
    console.log(`PASS ${target.provider} stream:   ${streamInfo}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${target.provider} stream:   ${(err as Error).message}`);
  }
}

console.log(`\n${ran} provider(s) tested, ${failures} failure(s)`);
process.exit(failures > 0 ? 1 : 0);
