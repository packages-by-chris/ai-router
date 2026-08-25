import { getRouter } from "@/lib/router";

/**
 * GET /api/stats — live engine observability snapshot:
 * strategy, circuit breakers, key cursors, limiter totals, per-route health
 * (percentiles, error tallies, key cooldowns), and recorded outcomes.
 */
export async function GET() {
  let router;
  try {
    router = getRouter();
  } catch (err) {
    return Response.json({ notice: (err as Error).message });
  }
  try {
    const stats = await router.stats();
    return Response.json(stats);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
