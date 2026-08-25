import type { FetchLike } from "../src/http/request.js";

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/** Scripted fetch: pops queued responses in order, records every call. */
export class MockFetch {
  readonly calls: RecordedCall[] = [];
  private readonly queue: (() => Response)[];

  constructor(...responses: Array<Response | (() => Response)>) {
    this.queue = responses.map((r) => (typeof r === "function" ? (r as () => Response) : () => r));
  }

  readonly fetch: FetchLike = async (url, init) => {
    this.calls.push({ url, init });
    const next = this.queue.shift();
    if (!next) throw new Error(`MockFetch: no scripted response for ${url}`);
    return next(url, init);
  };

  header(callIndex: number, name: string): string | undefined {
    const h = this.calls[callIndex]?.init?.headers as Record<string, string> | undefined;
    return h?.[name];
  }
}

export function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function sseResponse(events: string[], headers?: Record<string, string>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

export function completionJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    ...overrides,
  };
}

export function chunkJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    ...overrides,
  });
}
