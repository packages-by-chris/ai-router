# AGENTS.md

## Repo structure

Turborepo monorepo. npm workspaces.

```
packages/core/   → @ai-router/core — the library (zero runtime deps)
packages/redis/  → @ai-router/redis — Redis RateLimitStore adapter
apps/example/    → Next.js chat UI (demo)
apps/docs/       → Next.js docs site
scripts/smoke.ts → live provider smoke test
```

## Commands

```bash
npm install          # must run first
npm test             # vitest, all packages (no cache)
npm run conformance  # cross-SDK fixture tests (core only)
npm run typecheck    # all packages (depends on build)
npm run build        # tsc for core/redis, next build for apps
npm run smoke        # live API test — needs provider env vars
```

Run single package test: `npm test -w @ai-router/core`
Run single file: `npx vitest run packages/core/tests/config.test.ts`

Order matters: `build → typecheck` (turbo dep). Tests don't depend on build.

## TypeScript

- ESM-only (`"type": "module"`)
- Target ES2022, strict, `noUncheckedIndexedAccess`
- `Bundler` module resolution (not Node16/NodeNext)
- Extend `tsconfig.base.json` from repo root

## Key design constraints

- `model` field in requests is a **route id**, never a provider model name
- Provider adapters: OpenAI, Anthropic, Gemini, `openai-compatible`
- Zero runtime deps — only `fetch` + WebStreams
- Client-side library, not a gateway service
- Conformance fixtures (`packages/core/conformance/cases/*.json`) are the cross-SDK drift guard — never edit unilaterally; port changes to both SDKs

## Provider adapter pattern

Add new providers in `packages/core/src/providers/`. Implement `ProviderAdapter` interface. Register in `registry.ts`. Each adapter translates unified OpenAI-shaped requests to provider-specific wire format.

## Testing

- Vitest, no snapshot tests
- Tests read env vars (don't cache) — mock-based unit tests
- Conformance tests validate request translation against JSON fixtures
- Smoke test: `OPENAI_API_KEY=... npx tsx scripts/smoke.ts`

## Gotchas

- `packageManager` is npm 10.9.8 — don't use yarn/pnpm
- `overrides` pins `@types/react` to 19.2.18 — respect this
- Redis adapter has no hard dep on ioredis/node-redis (bring your own client)
- In-process rate limiting undercounts in multi-replica — use Redis adapter
- Next.js apps use `--webpack` flag in dev/build scripts
