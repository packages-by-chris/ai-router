import { AIRouter } from "@ai-router/core";
import type { TestResult } from "@/lib/protocol";
import { getRoutes } from "@/lib/router";

/**
 * POST /api/test-chain — health-probes every route in the chain
 * independently (single-route router each, so fallbacks can't mask a dead
 * primary). One tiny completion per route (~8 tokens). Sequential to avoid
 * tripping rpm limits the test itself would report. Each probe has a 10s
 * abort timeout.
 */
export async function POST() {
  let routes;
  try {
    routes = getRoutes();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const results: TestResult[] = [];
  for (const route of routes) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      // Solo router: this route only — no fallback to hide behind.
      const solo = new AIRouter({ routes: [{ ...route, maxRetries: 0 }] });
      const res = await solo.complete(
        {
          model: route.id,
          messages: [{ role: "user", content: "Reply with exactly: ok" }],
          max_tokens: 8,
        },
        { signal: controller.signal },
      );
      results.push({
        id: route.id,
        provider: route.provider,
        model: route.model,
        ok: true,
        ms: Date.now() - started,
        sample: typeof res.choices[0]?.message.content === "string"
          ? res.choices[0].message.content.slice(0, 24)
          : undefined,
      });
    } catch (err) {
      const attempts =
        (err as { attempts?: { kind?: string; message?: string }[] }).attempts ?? [];
      const last = attempts[attempts.length - 1];
      results.push({
        id: route.id,
        provider: route.provider,
        model: route.model,
        ok: false,
        ms: Date.now() - started,
        error: last?.message ?? (err as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return Response.json({ results });
}
