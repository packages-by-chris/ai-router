import { getPrimary, getRouter } from "@/lib/router";

/**
 * POST /api/explain — dry-run routing: the full decision (candidates,
 * rejections with reasons, estimated cost, observed latency) WITHOUT
 * executing a request or consuming rate-limit quota.
 *
 * Body: { model?: string, messages: [{ role, content }] }
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    model?: unknown;
    messages?: unknown;
  } | null;
  if (body === null || !Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json(
      { error: "messages[] required" },
      { status: 400 },
    );
  }

  let router;
  let model: string;
  try {
    router = getRouter();
    model =
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : getPrimary();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  try {
    const explanation = await router.explain({
      model,
      messages: [{ role: "user", content: String(body.messages.at(-1) ?? "ping") }],
    });
    return Response.json(explanation);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
