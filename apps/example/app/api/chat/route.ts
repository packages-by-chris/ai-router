import type { ChatFrame } from "@/lib/protocol";
import type { ChatMessage, Role } from "@ai-router/core";
import { getPrimary, getRouter } from "@/lib/router";

/** Demo knob: override with DEMO_MAX_TOKENS env var. */
const MAX_TOKENS = Number(process.env.DEMO_MAX_TOKENS) || 512;

const ROLES = new Set<string>(["system", "user", "assistant", "tool"]);

/**
 * Validate the messages payload before it reaches any adapter. Returns null
 * on anything malformed so callers get a clean 400 instead of a confusing
 * provider-side error.
 */
function parseMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const m of input) {
    if (typeof m !== "object" || m === null) return null;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || !ROLES.has(role)) return null;
    if (typeof content !== "string" && content !== null && !Array.isArray(content)) {
      return null;
    }
    out.push({ role: role as Role, content: content as ChatMessage["content"] });
  }
  return out;
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
  const body = (await req.json().catch(() => null)) as {
    messages?: unknown;
    model?: unknown;
  } | null;
  const messages = body === null ? null : parseMessages(body.messages);
  if (!messages) {
    return Response.json(
      { error: "messages[] required — items need role (system|user|assistant|tool) and string content" },
      { status: 400 },
    );
  }

  let router;
  let model: string;
  try {
    router = getRouter();
    model =
      typeof body!.model === "string" && body!.model.trim()
        ? body!.model.trim()
        : getPrimary();
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const output = new ReadableStream<Uint8Array>({
    async start(controller) {
      // desiredSize === null once the stream is closed or cancelled (client
      // disconnect → req.signal fires). No-op instead of throwing.
      const send = (frame: ChatFrame) => {
        if (controller.desiredSize === null) return;
        controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
      };
      const started = Date.now();
      try {
        // Wire client disconnect → abort signal.
        const stream = await router.stream(
          {
            model,
            messages,
            max_tokens: MAX_TOKENS,
          },
          {
            signal: req.signal,
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
        try {
          controller.close();
        } catch {
          // already closed by an abort
        }
      }
    },
  });

  return new Response(output, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
