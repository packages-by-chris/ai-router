---
title: Streaming
description: Committed streams — one async chunk shape across all providers.
---

# Streaming

```ts
const stream = await router.stream({
  model: "fast",
  messages: [{ role: "user", content: "hi" }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.delta.content ?? "");
}
```

Every provider's SSE protocol is normalized into one chunk shape:

```ts
interface ChatChunk {
  id: string;
  model: string;
  /** Provider that actually served the request. */
  provider: string;
  delta: Delta; // { role?, content?, tool_calls? }
  finish_reason: string | null;
  /** Appears on the final chunk when the provider reports usage. */
  usage?: Usage;
}
```

## The commit boundary

`router.stream()` returns a **committed** stream. By the time the promise
resolves:

- The HTTP request has been made and returned a success status.
- The first chunk has arrived from the provider.
- The serving route is **final**.

All attempt events (retries, key rotations, fallbacks) are emitted through
`onAttempt` before the first delta. Post-commit errors — a dropped connection
mid-stream, a malformed late event — surface during iteration, because swapping
providers mid-stream would corrupt your output. Design consumers accordingly:
if you have already flushed text to a user, an error is shown inline, not
silently retried elsewhere.

## Tool calls

Streaming tool calls arrive as deltas on `chunk.delta.tool_calls`, indexed the
same way OpenAI streams them:

```ts
for await (const chunk of stream) {
  for (const call of chunk.delta.tool_calls ?? []) {
    // call.index, call.id?, call.function?.name?, call.function?.arguments?
  }
}
```

Accumulate `function.arguments` fragments per index until `finish_reason`
reports `"tool_calls"`.
