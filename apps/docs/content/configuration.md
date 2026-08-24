---
title: Configuration
description: The RouterConfig schema — routes, key pools, limits, and validation.
---

# Configuration

A `RouterConfig` is a plain JSON-serializable object. It is the cross-language
contract of the project: the Python SDK validates against the same schema, and
the [conformance fixtures](/docs/conformance) are data-driven from it.

Pass raw unvalidated input (a JSON file, a POST body) straight to the
constructor — it is parsed and validated for you:

```ts
import { AIRouter } from "@ai-router/core";

const router = new AIRouter(configJson); // throws ConfigError if invalid
```

Validation errors are **aggregated** into a single `ConfigError` with all
problems listed — useful when the config comes from a user-facing form.

## RouterConfig

```ts
interface RouterConfig {
  routes: ModelRoute[];
}
```

`routes` is an **ordered fallback chain**. A request for route id at index `i`
tries routes `i`, `i+1`, … in order until one succeeds.

## ModelRoute

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Logical name requests refer to (`model` field). Must be unique. |
| `provider` | `ProviderId` | `"openai"` \| `"openai-compatible"` \| `"anthropic"` \| `"gemini"` |
| `model` | `string` | Provider-side model name, e.g. `"gpt-4o-mini"`. |
| `apiKey?` | `string` | Single key (convenience). |
| `apiKeys?` | `string[]` | Key pool. Merged with `apiKey`; rotates on rate_limit / auth / permission. |
| `baseUrl?` | `string` | Required for `"openai-compatible"`; overrides the default for known providers. |
| `headers?` | `Record<string, string>` | Extra headers merged over adapter defaults. |
| `maxRetries?` | `number` | Retries per route (same key or rotated). Default `2`. |
| `timeoutMs?` | `number` | Per-attempt HTTP timeout. Default `30000`. |
| `limit?` | `LimitRule` | Route rate limit — see [Rate limiting](/docs/rate-limiting). |

## LimitRule

```ts
interface LimitRule {
  rpm?: number; // requests per minute, enforced pre-flight
  tpm?: number; // tokens per minute, accounted post-hoc from usage reports
}
```

## Environment variable interpolation

`parseConfig` resolves `${ENV_VAR}` patterns in all string values. This lets
you load config from JSON files without embedding secrets:

```json
{
  "routes": [
    {
      "id": "fast",
      "provider": "openai",
      "model": "gpt-4o-mini",
      "apiKey": "${OPENAI_API_KEY}"
    },
    {
      "id": "backup",
      "provider": "anthropic",
      "model": "claude-haiku",
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  ]
}
```

By default, variables resolve against `process.env`. Pass an explicit env map
as the second argument:

```ts
import { parseConfig } from "@ai-router/core";

const config = parseConfig(jsonInput, {
  OPENAI_API_KEY: "sk-...",
  ANTHROPIC_API_KEY: "sk-ant-...",
});
```

Missing variables throw `ConfigError` with the variable name and JSON path:

```
config.routes[0].apiKey: environment variable "OPENAI_API_KEY" is not set
```

The pattern works in any string field: `apiKey`, `baseUrl`, `headers`, etc.

## Examples

Single route with a key pool and a budget:

```json
{
  "routes": [
    {
      "id": "smart",
      "provider": "anthropic",
      "model": "claude-sonnet-5",
      "apiKeys": ["sk-ant-1", "sk-ant-2", "sk-ant-3"],
      "limit": { "rpm": 50, "tpm": 40000 },
      "maxRetries": 3
    }
  ]
}
```

A fallback chain mixing providers:

```json
{
  "routes": [
    { "id": "fast", "provider": "openai", "model": "gpt-4o-mini", "apiKey": "..." },
    { "id": "cheap", provider: "openai-compatible", "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat", "apiKey": "..." },
    { "id": "backup", provider: "gemini", "model": "gemini-2.0-flash", "apiKey": "..." }
  ]
}
```

Requests always name `"fast"`, `"cheap"`, or `"backup"` — never a provider
model. See [Providers](/docs/providers) for per-provider behavior and defaults.
