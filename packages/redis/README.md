# @ai-router/redis

Redis-backed `RateLimitStore` for `@ai-router/core`. One shared counter
across all replicas of your app — the fix for per-process limiters
silently multiplying by replica count.

No hard dependencies: bring your own Redis client.

## Usage

```ts
import { AIRouter } from "@ai-router/core";
import { RedisStore, ioredisClient } from "@ai-router/redis";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

const router = new AIRouter(config, {
  store: new RedisStore({
    client: ioredisClient(redis),
    onError: (err) => logger.warn("rate-limit store unavailable", err),
  }),
});
```

node-redis v4+:

```ts
import { nodeRedisClient } from "@ai-router/redis";
import { createClient } from "redis";

const store = new RedisStore({ client: nodeRedisClient(client) });
```

Anything else (Upstash, cluster wrappers): implement the two-method surface —

```ts
const client = {
  eval: (script, keys, args) => upstash.eval(script, keys, args),
};
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `client` | required | Adapted Redis client (EVAL only) |
| `prefix` | `"ai-router:"` | Key namespace |
| `failOpen` | `true` | Redis down → allow + report (limiter is a guard, not the product). `false` → block while unreachable. |
| `onError` | — | Hook for logging/metrics on every client error |

## Implementation

Sliding-window log per key as a ZSET (`member` encodes cost, `score` is the
timestamp). Each `take`/`record` runs one Lua script so check-and-consume is
atomic across replicas. Keys expire via `PEXPIRE`; no TTL bookkeeping needed.

## Testing note

Unit tests run against a JS fake with identical semantics (no server
needed): `npm test`. The Lua scripts themselves need real Redis — wire this
into CI before trusting the package in production:

```bash
docker run -d -p 6379:6379 redis:7
npx tsx packages/redis/integration/run.ts   # TODO when CI exists
```
