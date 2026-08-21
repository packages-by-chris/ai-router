import { getPrimary, getRouter } from "@/lib/router";

interface ChatBody {
  messages?: { role: string; content: unknown }[];
  model?: string;
}

/**
 * POST /api/chat — NDJSON stream mixing routing events and text deltas:
 *
 *   {"type":"event","routeId":"openai","outcome":"error","kind":"server","attempts":2,...}
 *   {"type":"event","routeId":"anthropic","outcome":"ok","attempts":1,...}
 *   {"type":"delta","text":"Hel"}
 *   {"type":"done","finish":"stop"}
 *
 * Every fallback, retry, key rotation, and rate-limit skip is visible to the
 * client as it happens. All attempt events precede the first delta because
 * the engine commits before streaming starts.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ChatBody | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "messages[] required" }, { status: 400 });
  }

  let router;
  let model: string;
  try {
    router = getRouter();
    model = body.model ?? getPrimary();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const output = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      const started = Date.now();
      try {
        const stream = await router.stream(
          {
            model,
            messages: body.messages as never,
            max_tokens: 512,
          },
          {
            onAttempt: (event) => send({ type: "event", ...event }),
          },
        );
        // Resolving the stream = commit = first token reached us (upstream
        // TTFT + translation overhead included).
        const commitAt = Date.now();

        let finish: string | null = null;
        let chars = 0;
        let tokensOut: number | null = null;
        let servedProvider: string | undefined;
        let servedModel: string | undefined;

        for await (const chunk of stream) {
          if (!servedProvider && chunk.provider) {
            servedProvider = chunk.provider;
            servedModel = chunk.model;
          }
          if (chunk.delta.content) {
            chars += chunk.delta.content.length;
            send({ type: "delta", text: chunk.delta.content });
          }
          if (chunk.usage) tokensOut = chunk.usage.completion_tokens;
          if (chunk.finish_reason) finish = chunk.finish_reason;
        }

        const genMs = Math.max(1, Date.now() - commitAt);
        const tokens = tokensOut ?? Math.max(1, Math.round(chars / 4));
        send({
          type: "stats",
          provider: servedProvider,
          model: servedModel,
          ttftMs: commitAt - started,
          totalMs: Date.now() - started,
          tokens,
          tps: Math.round((tokens / genMs) * 1000),
        });
        send({ type: "done", finish });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(output, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
