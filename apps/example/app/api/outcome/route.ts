import { getRouter } from "@/lib/router";

/**
 * POST /api/outcome — record an application-observed outcome for the last
 * assistant reply (the adaptive-routing demo). The UI sends a thumbs
 * up/down; quality maps to 1 / 0. Latency and cost ride along when known.
 *
 * Body: { routeId, task?, success, latencyMs?, costUsd? }
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    routeId?: unknown;
    task?: unknown;
    success?: unknown;
    latencyMs?: unknown;
    costUsd?: unknown;
  } | null;

  if (
    body === null ||
    typeof body.routeId !== "string" ||
    body.routeId.length === 0 ||
    typeof body.success !== "boolean"
  ) {
    return Response.json(
      { error: "routeId (string) and success (boolean) required" },
      { status: 400 },
    );
  }

  let router;
  try {
    router = getRouter();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  router.recordOutcome({
    routeId: body.routeId,
    ...(typeof body.task === "string" && body.task.trim() ? { task: body.task.trim() } : {}),
    success: body.success,
    ...(typeof body.latencyMs === "number" ? { latencyMs: body.latencyMs } : {}),
    ...(typeof body.costUsd === "number" && Number.isFinite(body.costUsd)
      ? { costUsd: body.costUsd }
      : {}),
  });
  return Response.json({ ok: true });
}
