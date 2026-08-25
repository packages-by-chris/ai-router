import { describeState, removeRoute, setConfig } from "@/lib/router";

/** GET /api/config — current chain, strategy, demo pricing (keys masked). */
export async function GET() {
  try {
    const state = describeState();
    return Response.json(state);
  } catch (err) {
    return Response.json({ routes: [], notice: (err as Error).message });
  }
}

/**
 * POST /api/config — replace the fallback chain from the UI.
 * Body: { routes, strategy?, pricing? } where pricing maps routeId to
 * [usdPer1MInputTokens, usdPer1MOutputTokens] for cost-aware strategies.
 * Routes omitting credentials may set _keepKeyOf to reuse a stored key
 * (edit flow). Validation errors return 400 with aggregated messages.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (body === null) {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const result = setConfig(body);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  console.log(
    `[ai-router] config updated: ${result.routes.map((r) => r.provider).join(" -> ")}`,
  );
  return Response.json({
    ok: true,
    chain: result.routes.map((r) => ({ id: r.id, provider: r.provider, model: r.model })),
  });
}

/** DELETE /api/config?id=<routeId> — remove one route from the chain. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return Response.json({ error: "id query param required" }, { status: 400 });
  }

  const result = removeRoute(id);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json({ ok: true });
}
