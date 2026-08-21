# Conformance fixtures

The multi-language drift guard. Each SDK (TypeScript now, Python next) must
pass the **same** JSON fixtures against its own implementation.

## Contract

- `cases/*.json` — data-driven cases. Current kind: OpenAI request
  translation (`request` + `providerModel` + `stream` → `expected` body).
  Future kinds: response translation, SSE chunk sequences, fallback
  simulations against scripted mock servers.
- Config validation cases live here too once the JSON Schema for
  `RouterConfig` is published — both SDKs validate against one schema.

## Rules

1. A case failing in either SDK is a bug in that SDK — never "fix" it by
   editing the case unilaterally. Change the fixture in a dedicated commit
   and port it to the other SDK in the same PR.
2. New behavior = new fixture, in the same commit as the behavior.
3. Run: `bun run conformance` (TS) — the Python runner reads the same files.
