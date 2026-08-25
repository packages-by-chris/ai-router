---
title: Guardrails
description: Request/response validation hooks that can block or rewrite AI traffic.
---

# Guardrails

Validation hooks that run around every call. An input guard can veto or rewrite a request before it leaves; an output guard can veto or rewrite the response before it reaches your caller.

## Setup

Pass `guardrails` in `EngineOptions` (second argument to `AIRouter`):

```ts
import { AIRouter, type InputGuardrail } from "@ai-router/core";

const redactKeys: InputGuardrail = {
  name: "redact-api-keys",
  check(req) {
    let blocked = false;
    const messages = req.messages.map((m) => {
      if (typeof m.content === "string" && /sk-[a-zA-Z0-9]{20,}/.test(m.content)) {
        blocked = true;
        return { role: m.role, content: m.content.replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED]") };
      }
      return m;
    });
    // Returning replace rewrites traffic; returning pass:false blocks it.
    return { replace: { ...req, messages } };
  },
};

const router = new AIRouter(config, {
  guardrails: {
    input: [redactKeys],
    output: [],
  },
});
```

## Verdicts

A guard's `check` returns (or resolves to) a verdict:

| Field | Meaning |
|---|---|
| `pass` | `false` blocks the call with `GuardrailBlockedError`. Default: pass. |
| `reason` | Human-readable block reason, surfaced on the error. |
| `replace` | Substitute value flowing through — the rewritten `ChatRequest` (input phase) or `ChatResponse` (output phase). Enables redaction/rewriting guards. |

## Execution order

- **Input guards** run once per logical call, before routing AND before the response cache. A blocked input never reaches any provider and consumes no rate-limit budget.
- **Output guards** run after the provider succeeds — but **after** spend recording, because the provider charged regardless. A blocked output throws; it does **not** fall back to the next route (the same prompt would produce a similar output).
- Guards within a phase run in array order; each sees the previous guard's `replace` output.
- A throwing guard propagates its error — a broken guardrail is a caller bug worth surfacing, never something to silently swallow.

## Streams, embeds, and raw calls

| Call | Input guards | Output guards |
|---|---|---|
| `complete()` | ✅ | ✅ |
| `stream()` | ✅ | ❌ (scanning would require buffering, defeating streaming) |
| `embed()` | ✅ | ❌ (`EmbeddingResponse`, not `ChatResponse`) |
| `raw()` | ❌ | ❌ (verbatim passthrough by contract) |

## Error surface

```ts
import { GuardrailBlockedError } from "@ai-router/core";

try {
  await router.complete({ model: "fast", messages });
} catch (err) {
  if (err instanceof GuardrailBlockedError) {
    err.phase;      // "input" | "output"
    err.guardrail;  // guard name (or index fallback)
    err.reason;     // verdict reason, if provided
  }
}
```

Blocked calls fire an `onLog` event too — see [Observability](/docs/observability).
