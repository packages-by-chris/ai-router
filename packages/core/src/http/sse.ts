/**
 * Minimal SSE parser over WebStreams. Yields the payload of every `data:`
 * field. Event/id/retry fields and `:` comments are ignored (OpenAI-style
 * streams only use `data`). Handles CRLF, multi-line data fields, and
 * block boundaries split across network chunks.
 */

export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const boundary = nextBoundary(buffer);
        if (boundary === -1) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = extractData(block);
        if (data !== null) yield data;
      }
    }

    buffer += decoder.decode();
    const tail = extractData(buffer);
    if (tail !== null) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function nextBoundary(buf: string): { index: number; length: number } | -1 {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function extractData(block: string): string | null {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      // Strip the field name and at most one leading space, per SSE spec.
      let value = line.slice("data:".length);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
    }
    // ":" comment, "event:", "id:", "retry:" — ignored.
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

/** Helper for tests and conformance fixtures: body from a string. */
export function streamFromChunks(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}
