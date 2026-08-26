# Contributing to ai-router

Thanks for your interest. This document covers the rules that keep the
multi-SDK contract intact.

## Setup

```bash
npm install          # npm 10.9.8 (see packageManager) — don't use yarn/pnpm
npm test             # vitest, all packages
npm run conformance  # cross-SDK fixture tests
npm run typecheck    # depends on build
npm run build        # turbo build
```

## Repo layout

```
packages/core/   @ai-router/core — the library (zero runtime deps)
packages/redis/  @ai-router/redis — Redis RateLimitStore adapter
apps/gateway/    OpenAI-compatible HTTP gateway (optional, for tools)
apps/example/    Next.js chat demo
apps/docs/       docs site
```

## Hard rules

1. **Zero runtime deps in core.** Only `fetch` + WebStreams + WebCrypto.
   No polyfill packages, no node builtins in `src/` except type-only uses.
   Hand-roll small utilities instead of adding dependencies.
2. **Conformance fixtures are the cross-SDK drift guard**
   (`packages/core/conformance/cases/*.json`). Never edit them unilaterally —
   every change must be ported to the Python SDK in the same change. If a fix
   changes wire translation behavior, add a fixture case for it.
3. **`model` is a route id**, never a provider model name.
4. **ESM-only**, strict TypeScript, extend `tsconfig.base.json`.
   `noUncheckedIndexedAccess` is on — index access needs `!` or a check.

## Adding a provider

Prefer a preset over an adapter: most vendors serve OpenAI-compatible chat
completions, so a new provider is one entry in
`packages/core/src/providers/presets.ts` (base URL + auth style). Write a
native adapter only for protocol outliers. Requirements:

- implement `ProviderAdapter` (`complete`, `stream`, `raw`, optional `embed`)
- register in `registry.ts`
- unit tests for request + response + stream translation (mock fetch)
- fixture cases in `conformance/cases/` for pure translation functions

## Testing

- Vitest. No snapshot tests.
- Tests must not depend on ambient state; env vars are read at call time.
- New engine features need tests covering: success path, each failure-recovery
  layer (retry / key rotation / fallback), and caller abort.
- Failure scenarios use the deterministic simulator
  (`packages/core/tests/simulator.ts`) — scripted per-host behaviors, no real
  network, replayable. Prefer it over ad-hoc mocks for new routing tests.
- Telemetry/error surfaces must never contain credentials. If you add a new
  event type, error field, or API response shape, extend
  `tests/security.test.ts` with a leak assertion for it.

## Routing internals (`packages/core/src/routing/`)

- `capabilities.ts` — capability metadata + elimination rules. Explicit
  `routing.require` is a HARD constraint (undeclared = rejected);
  request-inferred requirements are METADATA-DRIVEN (only declared profiles
  can conflict). Keep this asymmetry — it is what preserves backwards
  compatibility.
- `health.ts` — in-memory per-route health: latency/TTFT ring buffers,
  percentiles, per-key cooldowns. No shared backend by design (same trade-off
  as the circuit breaker).
- `order.ts` — candidate scoring for cheapest/balanced/quality-first. Missing
  signals degrade to neutral 0.5; never throw on partial data.
- `outcomes.ts` — application-recorded quality EMAs keyed by task+route.

## Commit / PR style

- Small diffs. One feature per PR.
- Run `npm test && npm run conformance && npm run build` before pushing.
- Commit message: imperative, e.g. "add bedrock adapter", "fix sse crlf split".
