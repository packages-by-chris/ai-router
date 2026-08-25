# Security

ai-router is a client-side library: it holds **your** provider API keys in
**your** process and sends them only to the provider endpoints you
configured. This document covers the threat model and the guarantees the
codebase (and its tests) enforce.

## Credential handling

- Keys live in `RouterConfig` (`apiKey` / `apiKeys` per route) and are passed
  to adapters only at request time. They are never written to logs, errors,
  telemetry events, stats, or explanations.
- `Authorization` headers are constructed inside adapters and never echoed.
- Observability surfaces are covered by leak tests
  (`packages/core/tests/security.test.ts`): `onAttempt`, `onLog`,
  `onFinish`, `ProviderError.message/body`, `AllRoutesFailedError.attempts`,
  `stats()`, `explain()`, and stream chunks. If you add a surface, add an
  assertion.
- Custom routing filters receive a secret-free `RouteView`
  (`id`, `provider`, `model`, `weight?`, `capabilities?`) — never the route's
  key material.

## Browser exposure — read this before client-side use

Because ai-router is embeddable, nothing stops you from importing it in a
browser bundle — which would ship your provider keys to every visitor. The
library cannot prevent this; it is your architecture decision:

- **Server-side only is the safe default** (Next.js route handlers, server
  actions, workers). The bundled example app uses server-side API routes for
  exactly this reason.
- Edge/serverless deployments keep keys in platform secret stores
  (`process.env` via config interpolation `${ENV_VAR}`).
- If a browser must reach models, put ANY minimal proxy in front of it and
  let ai-router run there. Do not embed provider keys client-side.

## Error surfaces

- Provider error bodies are attached verbatim to `ProviderError.body` for
  debugging. Bodies come from the provider over TLS and do not contain your
  credentials, but treat them as untrusted third-party text: don't render
  them raw into HTML.
- `AllRoutesFailedError.attempts` carries route ids, providers, kinds, and
  provider messages — no secrets.

## Environment handling

- `parseConfig(input, env?)` interpolates `${VAR}` from the provided map or
  `process.env`. Missing variables throw `ConfigError` — configs fail closed,
  never silently route without keys.
- Config validation rejects unknown fields everywhere (typo protection), so
  a misnamed `apiKeyz` fails loudly instead of producing a keyless route.

## Redis adapter

`@ai-router/redis` stores rate-limit/budget counters as ZSET entries under a
namespaced prefix (`ai-router:` by default) with TTLs. It stores no
credentials and executes only fixed Lua scripts (no dynamic script bodies
from user input). Use a TLS-connected, authenticated Redis instance; the
adapter never disables auth.

## Prototype pollution & injection

- No `eval`, no `new Function`, no dynamic `require`.
- Config parsing builds plain objects from validated fields only; unknown
  keys are rejected rather than merged.
- Response cache keys hash the logical request (FNV-1a) — collisions serve a
  wrong cached response in adversarial setups; use a stronger hash or
  namespace in the backing store if callers can influence cache keys.
- Custom guardrails/filters/middleware run arbitrary code BY CONTRACT (you
  wrote them); they run with full process privileges like the rest of your app.

## Dependency posture

Zero runtime dependencies in `@ai-router/core`; `@ai-router/redis` also has
none (bring-your-own client, adapted at the call boundary). Supply-chain
surface = devDependencies + your own lockfile. Run `npm audit` in CI.

## Reporting

See the repository's security policy / private vulnerability reporting before
opening public issues for suspected vulnerabilities.
