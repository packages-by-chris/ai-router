---
title: Gateway
description: Expose your routing config as an OpenAI-compatible HTTP endpoint for tools like Cursor, OpenCode, and Aider.
---

# Gateway

The core library runs **in your process**. But tools you don't control —
Cursor, OpenCode, Aider, Continue, LibreChat — can't import npm packages.
They only speak HTTP. The optional gateway app (`apps/gateway`) wraps the
same `AIRouter` in a zero-dependency OpenAI-compatible server, so any tool
that accepts an "OpenAI base URL" can route through your fallback chains,
key pools, budgets, and circuit breakers.

```
your JS/TS code ──────────────▶ @ai-router/core        (library call)
Cursor / OpenCode / Aider ──┐
                            ├──────────▶ gateway :8787 ──▶ same AIRouter
any OpenAI client ──────────┘            /v1/*
```

Both doors share one config — edit routes once, every consumer changes.

## Run it

```sh
ROUTER_CONFIG=./router.json \
GATEWAY_API_KEY=$(openssl rand -hex 32) \
npm run dev -w @ai-router/gateway
```

| Env var | Meaning |
| --- | --- |
| `ROUTER_CONFIG` | Path to a router config JSON file, or an inline JSON string. Required. |
| `GATEWAY_API_KEY` | Bearer key clients must present. Required unless `GATEWAY_INSECURE=1`. |
| `GATEWAY_PORT` | Listen port. Default `8787`. |

The config file is exactly the [`RouterConfig`](/docs/configuration) schema,
including `${ENV_VAR}` interpolation — provider keys resolve from the
gateway process's environment and never appear in the file itself.

## Point tools at it

Any client with "OpenAI-compatible / custom base URL" support works:

```txt
Base URL: http://127.0.0.1:8787/v1
API key:  <value of GATEWAY_API_KEY>
Model:    <route id, e.g. "fast">
```

- **Cursor** — Settings → Models → Override OpenAI Base URL.
- **OpenCode** — custom provider entry with `baseUrl` above.
- **Aider / Continue / LibreChat** — OpenAI-compatible provider settings.

> **Anthropic-native clients:** Claude Code speaks the Anthropic wire format
> (`/v1/messages`) natively and cannot consume this gateway's OpenAI-shaped
> surface directly today. Use it with clients that accept an OpenAI base
> URL; an Anthropic-format surface is possible future work.

## Endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /healthz` | Liveness probe. No auth. |
| `GET /v1/models` | Your route ids, listed as model entries. |
| `POST /v1/chat/completions` | Unified completions. `"stream": true` returns SSE frames ending with `data: [DONE]`. |
| `POST /v1/embeddings` | Embeddings; routes without embedding support fall through the chain. |
| `GET /admin/stats` | Engine observability snapshot (`router.stats()`) as JSON — circuit breakers, key cursors, latencies, rate-limit totals, health, outcomes. Same Bearer key. |

### Observability headers

Every completion response (JSON and SSE) carries:

| Header | Meaning |
| --- | --- |
| `x-ai-router-route` | Route id that served the request (after fallback). |
| `x-ai-router-model` | Provider-side model name that answered. |
| `x-ai-router-attempts` | Total adapter tries across all routes. |
| `x-ai-router-cost-usd` | Computed cost when pricing is configured (non-stream only). |

### Per-call routing constraints

OpenAI clients can't send engine options, so the gateway accepts them as
request headers on `/v1/chat/completions`:

| Header | Maps to |
| --- | --- |
| `x-routing-task: support` | `routing.task` (quality-first bucket) |
| `x-routing-max-cost-usd: 0.5` | `routing.maxCostUsd` |
| `x-routing-max-latency-ms: 5000` | `routing.maxLatencyMs` |
| `x-routing-require-tools: true` | `routing.require.tools` — hard constraint; undeclared routes are eliminated |

Invalid or absent headers are ignored.

Requests are standard OpenAI shapes; the `model` field is your **route id**
(same rule as the library — see [Routes, not model names](https://github.com/#readme)).
Unknown fields are ignored; responses may carry extra fields (`provider`,
`cost_usd` when pricing is configured) which well-behaved clients ignore.

## Auth

Two different keys, two different jobs:

- **Provider keys** (`OPENAI_API_KEY`, …) live only in the gateway process,
  injected through config interpolation.
- **`GATEWAY_API_KEY`** is the door pass you hand to tools. It authorizes
  nothing at any provider — leaking it exposes only your proxy, and rotation
  is one env var.

Comparison is constant-time. Starting without `GATEWAY_API_KEY` refuses to
boot; `GATEWAY_INSECURE=1` disables auth for local experimentation and logs
a loud warning.

## Error mapping

Engine errors translate to HTTP semantics:

| Engine error | HTTP |
| --- | --- |
| `ConfigError` (unknown route id, bad request shape) | `400` |
| `RateLimitedError` (route rpm exhausted) | `429` + `Retry-After` |
| `AllRoutesFailedError` (every route exhausted) | `502` (+ `Retry-After` when a provider advertised one) |
| `DeadlineExceededError` | `504` |
| Provider errors with upstream status | status preserved where sensible |

Client disconnects abort the in-flight call **and its upstream fetch** — no
orphaned provider requests after a user cancels in their tool.

## What it does and doesn't do

Included free, because the gateway calls the real engine:

fallback chains · retries with backoff · key-pool rotation · circuit
breakers · rate limits · USD budgets · capability gating · guardrails ·
response cache · cost accounting.

Not exposed over HTTP:

- `router.raw()` — by design; the unified surface is the contract.
- `explain()` / `recordOutcome()` / middleware — engine-level APIs stay
  library-side. `stats()` is available at `GET /admin/stats`.
- Per-client API keys or a management UI — one shared gateway key today.

## Layout

```sh
apps/gateway/src/server.ts   createGatewayServer() — framework-free node:http
apps/gateway/src/cli.ts      env wiring + startup checks
apps/gateway/tests/          e2e tests against a mock upstream
```
