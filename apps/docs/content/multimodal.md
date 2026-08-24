---
title: Multimodal
description: Sending text + image content parts through the unified surface.
---

# Multimodal

Unified messages accept OpenAI-style content parts — plain strings stay valid:

```ts
const res = await router.complete({
  model: "vision",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What's in this image?" },
        { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
      ],
    },
  ],
});
```

## Image sources

`image_url.url` accepts either an `https(s)` URL or a `data:` URI with
base64 payload:

```ts
{ type: "image_url",
  image_url: { url: "data:image/png;base64,iVBORw0KGgo..." } }
```

## The detail hint

The optional `detail` field (`"auto" | "low" | "high"`) is an **OpenAI-only**
hint. Other providers drop it rather than fail — the same request body stays
portable across your whole chain.

## Per-provider translation

Parts are translated to each provider's native shape (Anthropic `image`
blocks, Gemini `inline_data` parts) before the request leaves the engine.

## What is not modeled

Only text + image parts exist in the unified layer. Audio, video, and files
belong in [`router.raw()`](/docs/raw-requests) until they earn unified types.
Anthropic thinking blocks are likewise dropped by translation — use raw for
those too.
