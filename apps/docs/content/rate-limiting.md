---
title: Rate limiting
description: rpm/tpm budgets, the pluggable RateLimitStore, and the Redis store for multi-replica deployments.
---

# Rate limiting

Routes can carry a budget:

```json
{ "limit": { "rpm": 50, "tpm": 40000 } }
```

- **`rpm`** (requests/minute) is enforced **pre-flight**: an exhausted route is
  skipped before any HTTP call and the chain moves on.
- **`tpm`** (tokens/minute) is accounted **post-hoc** from provider usage
  reports on each response.

Windows are 60-second sliding windows. The engine never sleeps waiting for
budget — it routes elsewhere.

## USD spend budgets

Beyond request/token limits, a route can cap **spend**:

```json
{ "budget": { "usd": 0.50, "windowMs": 60000 } }
```

Spend is computed from provider usage reports when [`pricing`](/docs/api-reference)
is configured for the route (or its model name), and recorded post-hoc in
micro-dollar integers. Pre-flight, the engine reads the window's recorded
spend; at or over the cap the route is skipped (`outcome: "skipped_budget"`)
and traffic falls through. Stores without a `used()` read-back fail open —
budgets never gate unless the store can report spend.

## The store interface

Budget state lives behind a two-method interface:

```ts
interface RateLimitStore {
  /** Check-and-consume, called pre-flight. */
  take(key: string, cost: number, windowMs: number, limit: number): Promise<RateLimitDecision>;
  /** Add usage without gating (token/cost accounting). */
  record(key: string, cost: number, windowMs: number): Promise<void>;
  /** Current window total, for budget pre-flight checks. Optional. */
  used?(key: string, windowMs: number): Promise<number> | number;
}
```

The default is `MemoryStore`: exact in-process sliding windows, zero setup.
Correct for a single replica — but N replicas undercount by a factor of N.

## Multi-replica: @ai-router/redis

[`@ai-router/redis`](https://www.npmjs.com/package/@ai-router/redis) keeps
shared state in Redis so all replicas gate against one budget:

```sh
npm install @ai-router/redis ioredis
```

```ts
import { AIRouter } from "@ai-router/core";
import { RedisStore, ioredisClient } from "@ai-router/redis";
import Redis from "ioredis";

const router = new AIRouter(config, {
  store: new RedisStore({
    client: ioredisClient(new Redis(process.env.REDIS_URL)),
    prefix: "my-app", // namespace shared across replicas
  }),
});
```

Implementation notes:

- Sliding-window log per key, stored as a ZSET; one **Lua script per
  operation** keeps check-and-consume atomic across replicas.
- **No hard dependency on any client.** Adapters for `ioredis`
  (`ioredisClient`) and `node-redis` v4+ (`nodeRedisClient`) are included; for
  anything else (Upstash, cluster wrappers) implement the two-method
  `RedisEvalClient` surface (`eval(script, keys, args)`).
- **Fail-open by default** (`failOpen: true`): if Redis is down, requests are
  allowed and reported — the limiter is a guard, not the product. Set
  `failOpen: false` to block traffic while unreachable instead.

Other `RedisStoreOptions`: `prefix` (key namespace, default `"ai-router:"`),
`onError` (hook every client error into your logger/metrics), `now` (clock
injection for tests).
