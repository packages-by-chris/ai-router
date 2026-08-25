/**
 * Azure OpenAI adapter. Reuses the OpenAI wire translation wholesale —
 * Azure's chat completions/embeddings APIs are the same protocol behind a
 * different URL layout and auth header:
 *
 * - POST {baseUrl}/openai/deployments/{deployment}/chat/completions?api-version={v}
 * - `api-key` header instead of Authorization Bearer
 * - route.model is the DEPLOYMENT name; baseUrl is the resource root
 *   (e.g. https://{resource}.openai.azure.com); apiVersion is required
 *   (default "2024-10-21" for hand-built routes).
 */

import { OpenAIAdapter } from "./openai.js";
import type { NormalizedRoute, ProviderAdapter, RawRequestOptions } from "./types.js";

export const AZURE_DEFAULT_API_VERSION = "2024-10-21";

/** providerOptions namespaces merged into bodies ("azure" wins on conflict). */
const AZURE_OPTION_NAMESPACES = ["openai", "azure"] as const;

function requireAzure(route: NormalizedRoute): { base: string; apiVersion: string } {
  if (!route.baseUrl) {
    // parseConfig enforces this; defensive for hand-built routes.
    throw new Error(`route "${route.id}": azure provider requires baseUrl`);
  }
  return {
    base: route.baseUrl.replace(/\/+$/, ""),
    apiVersion: route.apiVersion ?? AZURE_DEFAULT_API_VERSION,
  };
}

function deploymentUrl(route: NormalizedRoute, action: string): string {
  const { base, apiVersion } = requireAzure(route);
  return (
    `${base}/openai/deployments/${encodeURIComponent(route.model)}/${action}` +
    `?api-version=${encodeURIComponent(apiVersion)}`
  );
}

export class AzureAdapter extends OpenAIAdapter implements ProviderAdapter {
  override readonly id = "azure";

  protected override labelFor(): string {
    return "azure";
  }

  /** Azure ignores OPENAI_DEFAULT_BASE_URL entirely. */
  protected override base(): string {
    return "";
  }

  protected override chatEndpoint(route: NormalizedRoute): string {
    return deploymentUrl(route, "chat/completions");
  }

  protected override embedEndpoint(route: NormalizedRoute): string {
    return deploymentUrl(route, "embeddings");
  }

  protected override rawEndpoint(route: NormalizedRoute, opts: RawRequestOptions): string {
    if (opts.path !== undefined) {
      const { base, apiVersion } = requireAzure(route);
      const sep = opts.path.includes("?") ? "&" : "?";
      return `${base}${opts.path}${sep}api-version=${encodeURIComponent(apiVersion)}`;
    }
    return deploymentUrl(route, "chat/completions");
  }

  protected override authHeaders(_route: NormalizedRoute, key: string): Record<string, string> {
    return { "api-key": key };
  }

  protected override optionNamespaces(): readonly string[] {
    return AZURE_OPTION_NAMESPACES;
  }
}
