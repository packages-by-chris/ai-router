import type { ChatChunk } from "./types.js";

/**
 * Collect all text content from a stream into a single string.
 * Usage: `const text = await streamText(router.stream(req));`
 */
export async function streamText(stream: AsyncIterable<ChatChunk>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    if (chunk.delta.content) text += chunk.delta.content;
  }
  return text;
}

/**
 * Collect all chunks from a stream into an array.
 * Usage: `const chunks = await collectStream(router.stream(req));`
 */
export async function collectStream(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
