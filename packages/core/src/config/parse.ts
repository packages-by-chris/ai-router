/**
 * Hand-rolled validation (zero runtime deps). Collects ALL violations and
 * reports them with JSON-path style locations so both SDKs can emit
 * identical messages. Keep in lockstep with the Python validator.
 *
 * Supports `${ENV_VAR}` interpolation in string values. Resolved against
 * the provided env map or `process.env` when available.
 */

import { ConfigError } from "../errors.js";
import { knownProviderIds } from "../providers/registry.js";
import { getPreset } from "../providers/presets.js";
import type { ModelRoute, RouterConfig } from "./schema.js";

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Known fields at each config level; anything else is a typo and rejected. */
const TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set(["routes", "strategy"]);
const ROUTE_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "provider",
  "model",
  "apiKey",
  "apiKeys",
  "baseUrl",
  "apiVersion",
  "region",
  "project",
  "headers",
  "maxRetries",
  "timeoutMs",
  "streamIdleTimeoutMs",
  "limit",
  "budget",
  "weight",
]);
const LIMIT_FIELDS: ReadonlySet<string> = new Set(["rpm", "tpm"]);
const BUDGET_FIELDS: ReadonlySet<string> = new Set(["usd", "windowMs"]);
const STRATEGIES: ReadonlySet<string> = new Set([
  "fallback",
  "round-robin",
  "weighted",
  "least-latency",
]);

/**
 * Recursively resolve `${VAR}` patterns in string values.
 * Missing vars throw a clear error.
 */
function interpolateEnv(value: unknown, env: Record<string, string | undefined>, path: string): unknown {
  if (typeof value !== "string") return value;
  if (!value.includes("${")) return value;
  return value.replace(ENV_PATTERN, (_, varName: string) => {
    const resolved = env[varName];
    if (resolved === undefined) {
      throw new ConfigError(`${path}: environment variable "${varName}" is not set`);
    }
    return resolved;
  });
}

function interpolateDeep(obj: unknown, env: Record<string, string | undefined>, path: string): unknown {
  if (typeof obj === "string") return interpolateEnv(obj, env, path);
  if (Array.isArray(obj)) return obj.map((item, i) => interpolateDeep(item, env, `${path}[${i}]`));
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateDeep(val, env, `${path}.${key}`);
    }
    return result;
  }
  return obj;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export function parseConfig(input: unknown, env?: Record<string, string | undefined>): RouterConfig {
  // Resolve ${VAR} patterns against env or process.env.
  const resolvedEnv = env ?? (typeof process !== "undefined" ? process.env : {});
  const interpolated = interpolateDeep(input, resolvedEnv, "config");

  const errors: string[] = [];

  if (!isObject(interpolated)) {
    throw new ConfigError("config: expected an object");
  }

  if (!Array.isArray(interpolated.routes)) {
    throw new ConfigError("config.routes: expected an array");
  }
  if (interpolated.routes.length === 0) {
    throw new ConfigError("config.routes: must not be empty");
  }

  for (const key of Object.keys(interpolated)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      errors.push(`config.${key}: unknown field (known: routes, strategy)`);
    }
  }

  const strategy = interpolated.strategy;
  if (strategy !== undefined && (typeof strategy !== "string" || !STRATEGIES.has(strategy))) {
    errors.push(
      'config.strategy: must be "fallback", "round-robin", "weighted", or "least-latency"',
    );
  }

  const seenIds = new Set<string>();
  const routes: ModelRoute[] = [];

  interpolated.routes.forEach((raw, i) => {
    const at = `config.routes[${i}]`;
    if (!isObject(raw)) {
      errors.push(`${at}: expected an object`);
      return;
    }

    for (const key of Object.keys(raw)) {
      if (!ROUTE_FIELDS.has(key)) {
        errors.push(`${at}.${key}: unknown field`);
      }
    }

    const id = raw.id;
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`${at}.id: must be a non-empty string`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`${at}.id: duplicate route id "${id}"`);
      return;
    }
    seenIds.add(id);

    const provider = raw.provider;
    if (typeof provider !== "string" || !knownProviderIds().includes(provider)) {
      errors.push(
        `${at}.provider: unknown provider ${JSON.stringify(provider)} (known: ${knownProviderIds().join(", ")})`,
      );
      return;
    }

    const model = raw.model;
    if (typeof model !== "string" || model.length === 0) {
      errors.push(`${at}.model: must be a non-empty string`);
      return;
    }

    const keyPool: string[] = [];
    if (raw.apiKey !== undefined) {
      if (typeof raw.apiKey !== "string" || raw.apiKey.length === 0) {
        errors.push(`${at}.apiKey: must be a non-empty string`);
        return;
      }
      keyPool.push(raw.apiKey);
    }
    if (raw.apiKeys !== undefined) {
      if (
        !Array.isArray(raw.apiKeys) ||
        raw.apiKeys.length === 0 ||
        !raw.apiKeys.every((k) => typeof k === "string" && k.length > 0)
      ) {
        errors.push(`${at}.apiKeys: must be a non-empty array of non-empty strings`);
        return;
      }
      keyPool.push(...raw.apiKeys);
    }
    if (keyPool.length === 0) {
      // Keyless routes are only valid for presets that declare no-auth
      // (local runtimes like ollama/vLLM).
      if (getPreset(provider)?.auth !== "none") {
        errors.push(`${at}: needs "apiKey" or "apiKeys"`);
        return;
      }
    }

    if (provider === "openai-compatible" && (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0)) {
      errors.push(`${at}.baseUrl: required when provider is "openai-compatible"`);
      return;
    }
    if (provider === "azure" && (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0)) {
      errors.push(`${at}.baseUrl: required when provider is "azure" (resource root, e.g. https://my-res.openai.azure.com)`);
      return;
    }
    if (provider === "azure") {
      if (typeof raw.apiVersion !== "string" || raw.apiVersion.length === 0) {
        errors.push(`${at}.apiVersion: required when provider is "azure" (e.g. "2024-10-21")`);
        return;
      }
    } else if (raw.apiVersion !== undefined) {
      errors.push(`${at}.apiVersion: only valid when provider is "azure"`);
      return;
    }
    for (const [field, ownerList, hint] of [
      ["region", ["bedrock", "vertex"], 'e.g. "us-east-1"'],
      ["project", ["vertex"], "GCP project id"],
    ] as const) {
      const owners: readonly string[] = ownerList;
      const value = raw[field];
      if (owners.includes(provider)) {
        if (typeof value !== "string" || value.length === 0) {
          errors.push(`${at}.${field}: required when provider is "${provider}" (${hint})`);
          return;
        }
      } else if (value !== undefined) {
        errors.push(`${at}.${field}: only valid when provider is ${owners.map((o) => `"${o}"`).join(" or ")}`);
        return;
      }
    }
    if (raw.baseUrl !== undefined && (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0)) {
      errors.push(`${at}.baseUrl: must be a non-empty string`);
      return;
    }

    if (raw.weight !== undefined && !(typeof raw.weight === "number" && raw.weight > 0)) {
      errors.push(`${at}.weight: must be a positive number`);
      return;
    }

    if (raw.headers !== undefined) {
      const h = raw.headers;
      if (
        !isObject(h) ||
        !Object.values(h).every((v) => typeof v === "string")
      ) {
        errors.push(`${at}.headers: must be an object of string -> string`);
        return;
      }
    }

    for (const [field, value] of [
      ["maxRetries", raw.maxRetries],
      ["timeoutMs", raw.timeoutMs],
      ["streamIdleTimeoutMs", raw.streamIdleTimeoutMs],
    ] as const) {
      if (value !== undefined && !positiveInt(value) && !(field === "maxRetries" && value === 0)) {
        errors.push(`${at}.${field}: must be a positive integer`);
        return;
      }
    }

    let limit: ModelRoute["limit"];
    if (raw.limit !== undefined) {
      if (!isObject(raw.limit)) {
        errors.push(`${at}.limit: expected an object`);
        return;
      }
      for (const key of Object.keys(raw.limit)) {
        if (!LIMIT_FIELDS.has(key)) {
          errors.push(`${at}.limit.${key}: unknown field (known: rpm, tpm)`);
        }
      }
      limit = {};
      if (raw.limit.rpm !== undefined) {
        if (!positiveInt(raw.limit.rpm)) {
          errors.push(`${at}.limit.rpm: must be a positive integer`);
          return;
        }
        limit.rpm = raw.limit.rpm as number;
      }
      if (raw.limit.tpm !== undefined) {
        if (!positiveInt(raw.limit.tpm)) {
          errors.push(`${at}.limit.tpm: must be a positive integer`);
          return;
        }
        limit.tpm = raw.limit.tpm as number;
      }
    }

    let budget: ModelRoute["budget"];
    if (raw.budget !== undefined) {
      if (!isObject(raw.budget)) {
        errors.push(`${at}.budget: expected an object`);
        return;
      }
      for (const key of Object.keys(raw.budget)) {
        if (!BUDGET_FIELDS.has(key)) {
          errors.push(`${at}.budget.${key}: unknown field (known: usd, windowMs)`);
        }
      }
      if (typeof raw.budget.usd !== "number" || !(raw.budget.usd > 0)) {
        errors.push(`${at}.budget.usd: must be a positive number`);
        return;
      }
      if (
        raw.budget.windowMs !== undefined &&
        !positiveInt(raw.budget.windowMs)
      ) {
        errors.push(`${at}.budget.windowMs: must be a positive integer`);
        return;
      }
      budget = { usd: raw.budget.usd as number, ...(raw.budget.windowMs !== undefined ? { windowMs: raw.budget.windowMs as number } : {}) };
    }

    routes.push({
      id,
      provider: provider as ModelRoute["provider"],
      model,
      apiKey: raw.apiKey as string | undefined,
      apiKeys: (raw.apiKeys as string[] | undefined)?.slice(),
      baseUrl: raw.baseUrl as string | undefined,
      apiVersion: raw.apiVersion as string | undefined,
      region: raw.region as string | undefined,
      project: raw.project as string | undefined,
      headers: raw.headers as Record<string, string> | undefined,
      maxRetries: raw.maxRetries as number | undefined,
      timeoutMs: raw.timeoutMs as number | undefined,
      streamIdleTimeoutMs: raw.streamIdleTimeoutMs as number | undefined,
      limit,
      budget,
      weight: raw.weight as number | undefined,
    });
  });

  if (errors.length > 0) {
    throw new ConfigError(errors.join("\n"));
  }

  return {
    routes,
    ...(typeof strategy === "string" ? { strategy: strategy as RouterConfig["strategy"] } : {}),
  };
}
