---
title: Conformance
description: JSON fixtures that pin the wire format — the drift guard across languages.
---

# Conformance

The unified surface is a **contract**, not just TypeScript types. The
`packages/core/conformance` directory holds JSON fixture cases that execute
against the TS implementation — and against the Python SDK planned in the
roadmap. Same fixtures, same expected outputs: that is the drift guard for the
multi-language contract.

## Case kinds

| Kind | Direction |
| --- | --- |
| `openai_request` | Unified request → OpenAI body |
| `anthropic_request` | Unified request → Anthropic body |
| `anthropic_response` | Anthropic message → unified response |
| `gemini_request` | Unified request → Gemini body |
| `gemini_response` | Gemini response → unified response |

Each case names a provider model, an optional streaming flag, and the exact
expected translation.

## Running

```sh
npm run conformance
```

Non-zero exit on any drift. CI should treat it as release-blocking: if a
translation changes without a fixture change (or vice versa), conformance
fails before consumers do.
