---
title: Dart SDK
description: The Dart & Flutter SDK for ai-router-sdk — type-safe AI routing, 100% cross-SDK behavioral parity, zero unnecessary runtime dependencies.
---

# Dart SDK

`ai_router` is the official Dart SDK for `ai-router-sdk`. It brings multi-provider AI routing, automatic fallback chains, streaming commit boundary, rate limiting, and provider translations directly to Dart and Flutter applications.

It is written with strict analysis mode (`strict-casts`, `strict-inference`, `strict-raw-types`) and standard Dart async streams (`Stream<ChatChunk>`), with 100% passing cross-SDK conformance fixtures.

## Installation

Add `ai_router` to your `pubspec.yaml`:

```yaml
dependencies:
  ai_router: ^0.1.0
```

Or install with `dart pub`:

```bash
dart pub add ai_router
```

## Quick Start

```dart
import 'dart:io';
import 'package:ai_router/ai_router.dart';

void main() async {
  // 1. Initialize router with declarative routes
  final router = AIRouter(
    config: parseConfig({
      'strategy': 'fallback',
      'routes': [
        {
          'id': 'fast',
          'provider': 'openai',
          'model': 'gpt-4o-mini',
          'apiKey': '${OPENAI_API_KEY}',
          'limit': {'rpm': 500},
        },
        {
          'id': 'backup-anthropic',
          'provider': 'anthropic',
          'model': 'claude-3-5-haiku-20241022',
          'apiKey': '${ANTHROPIC_API_KEY}',
        },
      ],
    }),
  );

  // 2. Complete requests with automatic fallback & retries
  final response = await router.complete(
    const ChatRequest(
      model: 'fast', // logical route id
      messages: [
        ChatMessage(role: Roles.user, content: 'Explain quantum computing in one sentence.'),
      ],
    ),
  );

  print(response.choices.first.message.content);
  print('Served by: ${response.provider}');

  // 3. Stream tokens with standard Dart streams
  final stream = router.stream(
    const ChatRequest(
      model: 'fast',
      messages: [
        ChatMessage(role: Roles.user, content: 'Count from 1 to 5.'),
      ],
    ),
  );

  await for (final chunk in stream) {
    if (chunk.delta.content != null) {
      stdout.write(chunk.delta.content);
    }
  }

  // Or collect stream text into a single String:
  // final fullText = await streamText(stream);
}
```

## Supported Features in Dart

- **Multi-Provider Unified API**: Native translation adapters for OpenAI, Anthropic Claude, Google Gemini, AWS Bedrock Converse (with built-in SigV4 signing), Google Cloud Vertex AI, Azure OpenAI, and generic OpenAI-compatible endpoints.
- **Ordered Fallback Chains & Key Pools**: Automatic key rotation on rate-limits (HTTP 429) and transparent failover across providers.
- **7 Routing Strategies**: `fallback`, `round-robin`, `weighted`, `least-latency`, `cheapest`, `quality-first`, and `balanced`.
- **In-Memory Sliding-Window Rate Limiting**: Request and token rate limits (`rpm`, `rpd`, `tpm`, `tpd`, `spendUsd`).
- **Streaming Commit Boundary**: Allows clean retries before the first byte, but guarantees at-most-once delivery without token duplication once streaming begins.
- **Guardrails**: Pluggable input and output guardrails to block prompt injections or scrub sensitive output tokens.
- **Observability**: Per-attempt lifecycle hooks (`onAttempt`) and health statistics tracking.

## Conformance & Testing

The Dart SDK shares the identical cross-SDK test suite with TypeScript and Python (`conformance/cases/*.json`):

```bash
npm run test:dart          # Run all unit and conformance tests
npm run conformance:dart   # Run cross-SDK JSON wire format tests
npm run analyze:dart       # Run strict Dart analyzer
```
