import {
  ANTHROPIC_DEFAULT_BASE_URL,
  GEMINI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_BASE_URL,
  getPreset,
} from "@ai-router-sdk/core";
import { getRoutes } from "@/lib/router";

/**
 * POST /api/models — list model ids for a provider, for the route editor
 * dropdown. Body: { provider, baseUrl?, apiKey?, routeId? }.
 * Blank apiKey + routeId reuses the stored key (edit flow).
 * Never persists or logs the key. Failures return { models: [], error }
 * so the UI can fall back to static suggestions.
 */
const TIMEOUT_MS = 8_000;

interface ModelsBody {
  provider?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  routeId?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function ids(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const row of data) {
    if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") {
      out.push((row as { id: string }).id);
    }
  }
  return out;
}

/** GET {base}/models with arbitrary headers — OpenAI + Anthropic wire shape. */
async function listModels(base: string, headers: Record<string, string>): Promise<string[]> {
  const res = await fetch(`${base}/models`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  return ids(json.data);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ModelsBody | null;
  if (body === null) return Response.json({ error: "invalid JSON body" }, { status: 400 });

  const provider = str(body.provider);
  if (!provider) return Response.json({ error: "provider required" }, { status: 400 });

  let key = str(body.apiKey);
  const routeId = str(body.routeId);
  if (!key && routeId) {
    const stored = getRoutes().find((r) => r.id === routeId);
    key = stored?.apiKey ?? stored?.apiKeys?.[0];
  }

  const preset = getPreset(provider);
  const defaults: Record<string, string> = {
    openai: OPENAI_DEFAULT_BASE_URL,
    anthropic: ANTHROPIC_DEFAULT_BASE_URL,
    gemini: GEMINI_DEFAULT_BASE_URL,
  };
  const base = (str(body.baseUrl) ?? preset?.baseUrl ?? defaults[provider])?.replace(/\/+$/, "");

  // Azure model = deployment name; listing needs the resource management API.
  if (!base || provider === "azure") return Response.json({ models: [] });

  try {
    if (provider === "gemini") {
      const url = `${base}/models?pageSize=200${key ? `&key=${encodeURIComponent(key)}` : ""}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return Response.json({ models: [], error: `HTTP ${res.status}` });
      const json = (await res.json()) as { models?: unknown };
      const out: string[] = [];
      if (Array.isArray(json.models)) {
        for (const row of json.models) {
          const name = row && typeof row === "object" ? (row as { name?: unknown }).name : undefined;
          if (typeof name === "string") out.push(name.replace(/^models\//, ""));
        }
      }
      return Response.json({ models: out });
    }

    const auth = preset?.auth;
    const headers: Record<string, string> = { ...(preset?.headers ?? {}) };
    if (provider === "anthropic") {
      headers["anthropic-version"] = "2023-06-01";
      if (key) headers["x-api-key"] = key;
    } else if (auth === undefined || auth === "bearer") {
      if (key) headers.authorization = `Bearer ${key}`;
    } else if (typeof auth === "object") {
      if (key) headers[auth.header] = key;
    }
    // auth === "none": local runtimes need no credentials

    return Response.json({ models: await listModels(base, headers) });
  } catch (err) {
    return Response.json({ models: [], error: (err as Error).message });
  }
}
