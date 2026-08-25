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

## Third-party adapters

The runner core is exported from `@ai-router/core` so external adapters
(registered via [`registerAdapter`](/docs/providers)) can prove translation
parity with the same fixture format:

```ts
import { runTranslationCases, type TranslationHandlers } from "@ai-router/core";

const handlers: TranslationHandlers = {
  bedrock_request: ({ request, providerModel }) => myTranslate(request!, providerModel),
};

const { total, failed } = runTranslationCases(myFixtureJson.cases, handlers);
```
