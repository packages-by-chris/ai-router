/**
 * Hand-rolled validation (zero runtime deps). Collects ALL violations and
 * reports them with JSON-path style locations so both SDKs can emit
 * identical messages. Keep in lockstep with the Python validator.
 */

import { ConfigError } from "../errors.js";
import { PROVIDER_IDS, type ModelRoute, type RouterConfig } from "./schema.js";

const PROVIDER_SET: ReadonlySet<string> = new Set(PROVIDER_IDS);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export function parseConfig(input: unknown): RouterConfig {
  const errors: string[] = [];

  if (!isObject(input)) {
    throw new ConfigError("config: expected an object");
  }

  if (!Array.isArray(input.routes)) {
    throw new ConfigError("config.routes: expected an array");
  }
  if (input.routes.length === 0) {
    throw new ConfigError("config.routes: must not be empty");
  }

  const seenIds = new Set<string>();
  const routes: ModelRoute[] = [];

  input.routes.forEach((raw, i) => {
    const at = `config.routes[${i}]`;
    if (!isObject(raw)) {
      errors.push(`${at}: expected an object`);
      return;
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
    if (typeof provider !== "string" || !PROVIDER_SET.has(provider)) {
      errors.push(
        `${at}.provider: unknown provider ${JSON.stringify(provider)} (known: ${PROVIDER_IDS.join(", ")})`,
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
      errors.push(`${at}: needs "apiKey" or "apiKeys"`);
      return;
    }

    if (provider === "openai-compatible" && (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0)) {
      errors.push(`${at}.baseUrl: required when provider is "openai-compatible"`);
      return;
    }
    if (raw.baseUrl !== undefined && (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0)) {
      errors.push(`${at}.baseUrl: must be a non-empty string`);
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

    routes.push({
      id,
      provider: provider as ModelRoute["provider"],
      model,
      apiKey: raw.apiKey as string | undefined,
      apiKeys: (raw.apiKeys as string[] | undefined)?.slice(),
      baseUrl: raw.baseUrl as string | undefined,
      headers: raw.headers as Record<string, string> | undefined,
      maxRetries: raw.maxRetries as number | undefined,
      timeoutMs: raw.timeoutMs as number | undefined,
      limit,
    });
  });

  if (errors.length > 0) {
    throw new ConfigError(errors.join("\n"));
  }

  return { routes };
}
