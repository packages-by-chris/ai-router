/**
 * Site-wide identity used by metadata, sitemap, robots, OG images, and
 * JSON-LD. Override the deployed origin with NEXT_PUBLIC_SITE_URL.
 */

export const SITE_NAME = "ai-router";

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://ai-router.dev"
).replace(/\/+$/, "");

export const SITE_TAGLINE = "Provider-agnostic AI routing for TypeScript";

export const SITE_DESCRIPTION =
  "ai-router puts fallback chains, key pools, rate limiting, and unified streaming for OpenAI, Anthropic, Gemini, and any OpenAI-compatible API behind one typed client — with zero runtime dependencies.";

export const SITE_KEYWORDS = [
  "AI router",
  "LLM routing",
  "fallback chain",
  "provider-agnostic AI",
  "unified LLM API",
  "OpenAI",
  "Anthropic",
  "Gemini",
  "TypeScript AI SDK",
  "LLM rate limiting",
  "API key rotation",
  "streaming LLM responses",
];

export function absoluteUrl(path = "/"): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
