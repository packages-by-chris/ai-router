# Conformance fixtures

The multi-language drift guard. Each SDK (TypeScript now, Python next) must
pass the **same** JSON fixtures against its own implementation.

## Contract

- `cases/*.json` — data-driven cases. Every case has `name`, `kind`,
  `providerModel`, and `expected`. Optional inputs per kind:

| Kind | Input | Notes |
|---|---|---|
| `openai_request` / `anthropic_request` / `gemini_request` / `bedrock_request` | `request` + `stream` | Unified ChatRequest → provider wire body |
| `openai_response` / `anthropic_response` / `gemini_response` / `bedrock_response` | `response` | Provider JSON → unified ChatResponse |
| `openai_chunk` | `response` (+ optional `label`) | Single SSE chunk payload → unified ChatChunk (or `null` for noise) |
| `sse_parse` | `response` = array of raw network chunk strings | Framing mechanics: yields the array of `data:` payloads |

- The optional `label` field overrides the provider label used in unified
  outputs (e.g. `"openai-compatible"` for preset vendors whose route id is
  unknowable from the wire).
- Handlers may be async; the runner awaits them.
- Future kinds: fallback simulations against scripted mock servers.
- Config validation cases live here too once the Python SDK ships — both
  SDKs validate against the published JSON Schema.

## Rules

1. A case failing in either SDK is a bug in that SDK — never "fix" it by
   editing the case unilaterally. Change the fixture in a dedicated commit
   and port it to the other SDK in the same PR.
2. New behavior = new fixture, in the same commit as the behavior.
3. Run: `npm run conformance` (TS) — the Python runner reads the same files.
