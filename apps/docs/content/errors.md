---
title: Errors
description: The typed error taxonomy — classes, kinds, and how classification drives recovery.
---

# Errors

Every failure gets a `kind` from a fixed taxonomy. Classification is what
drives the recovery layers in [Routing](/docs/routing):

```ts
type ErrorKind =
  | "rate_limit" | "auth" | "permission"
  | "not_found" | "invalid_request"
  | "server" | "network" | "timeout" | "unknown";
```

## Classification rules

| Kind | Source |
| --- | --- |
| `rate_limit` | HTTP 429 (or provider-equivalent), `Retry-After` honored when present |
| `auth` / `permission` | 401 / 403 |
| `not_found` | 404 |
| `invalid_request` | 400 |
| `server` | Any 5xx |
| `network` | Fetch-level failures (`fetchWithTimeout` normalizes these) |
| `timeout` | Per-attempt timeout exceeded |

Two predicates encode the recovery policy:

```ts
isRetryableKind(kind); // retry same route+key: rate_limit, server, network, timeout
isKeyRelatedKind(kind); // rotate key first:      rate_limit, auth, permission
```

## Error classes

All extend `AIRouterError`.

| Class | Meaning |
| --- | --- |
| `ConfigError` | Config validation failed; message lists **all** problems. |
| `UnsupportedProviderError` | Provider id not in the registry (config-parse time). |
| `ProviderError` | A provider call failed. Fields: `provider`, `kind`, `status?`, `retryAfterMs?`, `body?`. |
| `RateLimitedError` | Raw escape hatch hit an exhausted rpm budget. Fields: `routeId`, `retryAfterMs`. |
| `AllRoutesFailedError` | Every route in the chain failed. Field: `attempts[]` — one record per step, with outcome, kind, and key index. |

## Catching patterns

```ts
import { AllRoutesFailedError, RateLimitedError } from "@ai-router/core";

try {
  await router.complete(req);
} catch (err) {
  if (err instanceof AllRoutesFailedError) {
    // err.attempts: audit trail of the whole walk
  } else if (err instanceof RateLimitedError) {
    // raw() only — wait err.retryAfterMs
  } else {
    throw err;
  }
}
```
