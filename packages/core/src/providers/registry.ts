import { UnsupportedProviderError } from "../errors.js";
import { AnthropicAdapter } from "./anthropic.js";
import { AzureAdapter } from "./azure.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAIAdapter } from "./openai.js";
import { PROVIDER_PRESETS } from "./presets.js";
import type { ProviderAdapter } from "./types.js";

const openai = new OpenAIAdapter();
const azure = new AzureAdapter();
const anthropic = new AnthropicAdapter();
const gemini = new GeminiAdapter();

/**
 * Built-in adapters. "openai-compatible" is the same object as "openai" —
 * only the base URL differs.
 */
const builtinAdapters: Record<string, ProviderAdapter> = {
  openai,
  azure,
  anthropic,
  gemini,
};

/** Third-party adapters registered via registerAdapter (factory cache). */
const customAdapters = new Map<string, ProviderAdapter>();

/**
 * Register a third-party adapter under a provider id. After registration,
 * routes may declare `provider: "<id>"` and `parseConfig` accepts the id
 * (the known-provider union includes it). Call at module init time:
 *
 *   // @ai-router/provider-bedrock
 *   registerAdapter("bedrock", () => new BedrockAdapter());
 */
export function registerAdapter(
  id: string,
  create: () => ProviderAdapter,
): void {
  if (id in builtinAdapters) {
    throw new Error(`registerAdapter: "${id}" collides with a built-in provider`);
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(id)) {
    throw new Error(`registerAdapter: "${id}" must match [a-zA-Z][a-zA-Z0-9_-]*`);
  }
  customAdapters.set(id, create());
}

/**
 * Every provider id valid in route configs: built-ins + preset ids +
 * registered custom ids. parseConfig validates against this union.
 */
export function knownProviderIds(): string[] {
  return [
    ...Object.keys(builtinAdapters),
    "openai-compatible",
    ...Object.keys(PROVIDER_PRESETS),
    ...customAdapters.keys(),
  ];
}

export function getAdapter(providerId: string): ProviderAdapter {
  const builtin =
    builtinAdapters[providerId] ??
    // Same wire protocol; only the base URL differs.
    (providerId === "openai-compatible" ? openai : undefined);
  if (builtin) return builtin;
  const custom = customAdapters.get(providerId);
  if (custom) return custom;
  throw new UnsupportedProviderError(
    `provider "${providerId}" is not implemented` +
      (PROVIDER_PRESETS[providerId]
        ? ""
        : ` (known: ${knownProviderIds().join(", ")})`),
  );
}

export function isSupported(providerId: string): boolean {
  return (
    providerId in builtinAdapters ||
    providerId === "openai-compatible" ||
    customAdapters.has(providerId)
  );
}
