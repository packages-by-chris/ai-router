import { UnsupportedProviderError } from "../errors.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAIAdapter } from "./openai.js";
import type { ProviderAdapter } from "./types.js";

const openai = new OpenAIAdapter();
const anthropic = new AnthropicAdapter();
const gemini = new GeminiAdapter();

const adapters: Record<string, ProviderAdapter> = {
  openai,
  // Same wire protocol; only the base URL differs.
  "openai-compatible": openai,
  anthropic,
  gemini,
};

/**
 * All PROVIDER_IDS are implemented. Unknown provider ids are rejected at
 * config-parse time, so this error only fires for future registry gaps.
 */
export function getAdapter(providerId: string): ProviderAdapter {
  const adapter = adapters[providerId];
  if (!adapter) {
    throw new UnsupportedProviderError(
      `provider "${providerId}" is not implemented yet (planned: anthropic, gemini)`,
    );
  }
  return adapter;
}

export function isSupported(providerId: string): boolean {
  return providerId in adapters;
}
