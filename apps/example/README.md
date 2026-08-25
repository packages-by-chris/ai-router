# ai-router — Next.js example

Chat app with a **frontend-configurable fallback chain** and a **live
routing timeline**: add routes (provider, model, key, rpm) in the UI, then
watch every retry, fallback, rate-limit skip, and key rotation as it
happens, alongside the streamed answer.

## Run

```bash
# from the repo root — installs workspace deps
npm install

npm run dev --workspace @ai-router/example  # or: npm run dev -w @ai-router/docs for the docs site
# http://localhost:3000
```

## What it demonstrates

- **Config panel → `POST /api/config`** — routes validated by the core
  parser (aggregated errors go straight back to the UI), router hot-swapped
  in server memory. Keys are never persisted; `GET /api/config` returns them
  masked.
- **Strategy selector** — switch `fallback`, `round-robin`, `weighted`,
  `least-latency`, `cheapest`, `balanced`, and `quality-first` live; the
  chosen strategy persists with the config.
- **Capability declarations** — each stop can declare
  tools / vision / structuredOutput / streaming / reasoning / embeddings /
  context window, so incompatible candidates are eliminated before any
  request is made. Per-route USD pricing fields feed the cost-aware
  strategies.
- **Per-call routing toolbar** — set a whole-call deadline (`deadlineMs`),
  a task bucket for quality routing, `maxCostUsd` / `maxLatencyMs`
  constraints, and a "require tools" hard constraint on any send.
- **Routing plan** — every request starts with a dry-run frame from the
  engine's `explain()`: candidates, rejections with reasons, estimated cost,
  observed latency — before anything executes.
- **Live event timeline** — `POST /api/chat` streams NDJSON:
  `{"type":"event","routeId":"main","outcome":"error","kind":"server"}` lines
  for every routing decision (via the core's per-request `onAttempt` hook),
  interleaved with `{"type":"delta","text":...}` chunks. The UI renders the
  trail above each answer: what failed, what was skipped, who served, which
  key, which try.
- **Outcome feedback** — 👍/👎 on an answer calls `recordOutcome()` with the
  serving route id, latency, and cost; `quality-first` ordering uses it.
- **Engine health panel** — `GET /api/stats` surfaces per-route success /
  failure counts, p50/p95 latency, error tallies, and recorded outcome EMAs
  from the live engine.
- **Singleton router** (`lib/router.ts`) — `globalThis` cache so hot reloads
  don't reset key-pool cursors and rate-limit windows (Prisma-client pattern).
  Starts empty; add routes via the config panel.
- **Streaming commit boundary** — all attempt events precede the first
  delta (the engine commits before streaming); post-commit errors surface
  inline since a provider swap mid-stream is impossible.

## Notes

- The example imports `@ai-router/core`'s TypeScript source via tsconfig
  `paths` + `transpilePackages` (no build step). Apps installing the
  published package just `npm install @ai-router/core` — no config needed.
- `runtime = "nodejs"` is set on the route, but `edge` works too — the core
  uses only `fetch` + WebStreams.
- Keys posted from the browser transit your server — fine for a local demo
  console, not a pattern for a public app (anyone with the URL can register
  a route).
