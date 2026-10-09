# AGENTS.md

## Repo structure

Turborepo monorepo. npm workspaces.

```
packages/core/   → @ai-router-sdk/core — the TypeScript library (zero runtime deps)
packages/python/ → ai-router — the Python SDK (Python 3.10+, zero runtime deps)
packages/dart/   → ai_router — the Dart SDK (Dart 3.0+, minimal deps)
packages/go/     → github.com/ai-router-sdk/ai-router-go — the Go SDK (Go 1.21+, zero runtime deps)
packages/redis/  → @ai-router-sdk/redis — Redis RateLimitStore adapter
apps/example/    → Next.js chat UI (demo)
apps/docs/       → Next.js docs site
scripts/smoke.ts → live provider smoke test (TypeScript)
scripts/smoke.py → live provider smoke test (Python)
```

## Commands

### TypeScript / Monorepo
```bash
npm install          # must run first
npm test             # vitest, all packages (no cache)
npm run conformance  # cross-SDK fixture tests (core only)
npm run typecheck    # all packages (depends on build)
npm run build        # tsc for core/redis, next build for apps
npm run smoke        # live API test — needs provider env vars
```

### Python SDK
```bash
npm run test:python        # pytest, packages/python/tests
npm run conformance:python # cross-SDK fixture tests (python)
npm run typecheck:python   # mypy strict, packages/python/src
npm run smoke:python       # live API test — needs provider env vars
```

### Dart SDK
```bash
npm run test:dart          # dart test, packages/dart/test
npm run conformance:dart   # cross-SDK fixture tests (dart)
npm run analyze:dart       # dart analyze, strict type checking
```

### Go SDK
```bash
npm run test:go            # go test -v ./...
npm run conformance:go     # cross-SDK fixture tests (go)
```

Run single package test: `npm test -w @ai-router-sdk/core`
Run single file: `npx vitest run packages/core/tests/config.test.ts`

Order matters: `build → typecheck` (turbo dep). Tests don't depend on build.

## Go SDK Guidelines

- Go 1.21+ requirement
- Zero external runtime dependencies (standard library only)
- 100% pass on cross-SDK conformance fixtures (`packages/core/conformance/cases/*.json`)
- Async streaming via Go channels (`<-chan ChatChunk`, `<-chan error`)
- Context cancellation & deadline propagation (`context.Context`)

## Dart SDK Guidelines

- Dart SDK >=3.0.0 requirement
- Strict analysis mode (`strict-casts`, `strict-inference`, `strict-raw-types`)
- 100% pass on cross-SDK conformance fixtures (`packages/core/conformance/cases/*.json`)
- Async streaming via standard Dart `Stream<ChatChunk>` and `Stream<String>`
- Full support for multi-provider routing, fallbacks, retries, rate limiting, and guardrails

## Python SDK Guidelines

- Python 3.10+ requirement
- Zero mandatory runtime dependencies (standard library first)
- Strict `mypy` typing & clean `pyright` language server diagnostics
- PEP 604 pipe syntax for union types (`A | B`)
- 100% pass on cross-SDK conformance fixtures (`packages/core/conformance/cases/*.json`)
- Sync (`complete_sync`, `stream_sync`, `raw_sync`) and async (`complete`, `stream`, `raw`) APIs on `AIRouter`

## TypeScript

- ESM-only (`"type": "module"`)
- Target ES2022, strict, `noUncheckedIndexedAccess`
- `Bundler` module resolution (not Node16/NodeNext)
- Extend `tsconfig.base.json` from repo root

## Key design constraints

- `model` field in requests is a **route id**, never a provider model name
- Provider adapters: OpenAI, Anthropic, Gemini, `openai-compatible`
- Zero runtime deps — only `fetch` + WebStreams (TS) / `urllib` + `dataclasses` (Python)
- Client-side library, not a gateway service
- Conformance fixtures (`packages/core/conformance/cases/*.json`) are the cross-SDK drift guard — never edit unilaterally; port changes to both SDKs

## Provider adapter pattern

Add new providers in `packages/core/src/providers/`. Implement `ProviderAdapter` interface. Register in `registry.ts`. Each adapter translates unified OpenAI-shaped requests to provider-specific wire format.

## API surface

### Core

- `AIRouter` — public facade. `complete()`, `stream()`, `raw()`.
- `RoutingEngine` — internal engine (exported for advanced use/testing).
- `parseConfig(input, env?)` — validates + interpolates `${ENV_VAR}` patterns.
- `streamText(stream)` / `collectStream(stream)` — stream collector utilities.

### Options

- `CallOptions`: `signal?: AbortSignal`, `onAttempt?: (event) => void`
- `EngineOptions`: `store`, `fetchImpl`, `sleep`, `rng`, `middleware`, `circuitBreaker`
- `Middleware`: `beforeRequest(ctx)`, `afterResponse(ctx, response)` — per-attempt hooks
- `CircuitBreaker`: `{ threshold?: number, cooldownMs?: number }` — skip route after N consecutive failures

### Config interpolation

`parseConfig` resolves `${ENV_VAR}` in string values against provided env map or `process.env`. Missing vars throw `ConfigError`.

## Testing

- Vitest, no snapshot tests
- Tests read env vars (don't cache) — mock-based unit tests
- Conformance tests validate both request AND response translation against JSON fixtures
- Smoke test: `OPENAI_API_KEY=... npx tsx scripts/smoke.ts`

## Gotchas

- `packageManager` is npm 10.9.8 — don't use yarn/pnpm
- `overrides` pins `@types/react` to 19.2.18 — respect this
- Redis adapter has no hard dep on ioredis/node-redis (bring your own client)
- In-process rate limiting undercounts in multi-replica — use Redis adapter
- Next.js apps use `--webpack` flag in dev/build scripts
- Conformance runner uses `import.meta.dirname` (not Bun's `import.meta.dir`)
