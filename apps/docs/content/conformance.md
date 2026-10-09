---
title: Conformance
description: JSON fixtures that pin the wire format — the drift guard across languages.
---

# Conformance

The unified surface is a **contract**, not just TypeScript types. The
`packages/core/conformance` directory holds JSON fixture cases that execute
against all SDK implementations — TypeScript (`@ai-router-sdk/core`), Python (`ai-router`),
Dart (`ai_router`), and Go (`github.com/ai-router-sdk/ai-router-go`). Same fixtures,
same expected outputs: that is the drift guard for the multi-language contract.

## Case kinds

| Kind | Direction |
| --- | --- |
| `openai_request` | Unified request → OpenAI body |
| `openai_response` | OpenAI body → unified response |
| `openai_chunk` | Single SSE chunk payload → unified chunk |
| `anthropic_request` | Unified request → Anthropic body |
| `anthropic_response` | Anthropic message → unified response |
| `gemini_request` | Unified request → Gemini body |
| `gemini_response` | Gemini response → unified response |
| `bedrock_request` | Unified request → Bedrock Converse body |
| `bedrock_response` | Bedrock Converse response → unified response |
| `sse_parse` | Raw event-stream bytes → parsed SSE data payloads |

Each case names a provider model, an optional streaming flag, and the exact
expected translation.

## Running

```sh
# TypeScript
npm run conformance

# Python
npm run conformance:python

# Dart
npm run conformance:dart

# Go
npm run conformance:go
```

Non-zero exit on any drift. CI treats this as release-blocking: if a
translation changes in one language without a fixture change, conformance
fails across the matrix before consumers do.

## Third-party adapters

The runner core is exported from `@ai-router-sdk/core` so external adapters
(registered via [`registerAdapter`](/docs/providers)) can prove translation
parity with the same fixture format:

```ts
import { runTranslationCases, type TranslationHandlers } from "@ai-router-sdk/core";

const handlers: TranslationHandlers = {
  bedrock_request: ({ request, providerModel }) => myTranslate(request!, providerModel),
};

const { total, failed } = runTranslationCases(myFixtureJson.cases, handlers);
```
