import { AIRouter, ConfigError, parseConfig, type ModelRoute } from "@ai-router/core";

/**
 * Router state for the demo.
 *
 * Routes are configurable from the frontend (POST/DELETE /api/config) and
 * live only in server memory — keys posted from the browser are never
 * persisted or logged. Edits may omit the key (`_keepKeyOf`) to reuse the
 * stored one, so the UI never has to display or resend real keys.
 *
 * The globalThis cache survives Next.js dev-mode hot reloads (Prisma-client
 * pattern).
 */

interface RouterState {
  router: AIRouter;
  routes: ModelRoute[];
}

const g = globalThis as typeof globalThis & { __aiRouterState?: RouterState };

function ensure(): RouterState {
  if (!g.__aiRouterState) {
    g.__aiRouterState = {
      router: new AIRouter({ routes: [] }),
      routes: [],
    };
  }
  return g.__aiRouterState;
}

export function getRouter(): AIRouter {
  const state = ensure();
  if (state.routes.length === 0) {
    throw new Error("No routes configured. Add routes in the config panel.");
  }
  return state.router;
}

export function getPrimary(): string {
  const state = ensure();
  if (state.routes.length === 0) {
    throw new Error("No routes configured. Add routes in the config panel.");
  }
  return state.routes[0]!.id;
}

/** Current chain (with keys) — used by the chain tester to probe each route. */
export function getRoutes(): ModelRoute[] {
  return ensure().routes.slice();
}

/**
 * Routes arriving from the UI may omit credentials (`_keepKeyOf: "<id>"`)
 * so an edit doesn't require retyping a stored key. Re-attach them here,
 * BEFORE validation sees the payload.
 */
function reattachStoredKeys(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !Array.isArray((input as { routes?: unknown }).routes)) {
    return input;
  }
  const prev = g.__aiRouterState?.routes ?? [];
  const routes = ((input as { routes: Record<string, unknown>[] }).routes).map((route) => {
    const keepOf = route._keepKeyOf;
    if (
      route.apiKey === undefined &&
      route.apiKeys === undefined &&
      typeof keepOf === "string"
    ) {
      const old = prev.find((p) => p.id === keepOf);
      if (old) {
        const { _keepKeyOf: _drop, ...rest } = route;
        return {
          ...rest,
          ...(old.apiKey !== undefined ? { apiKey: old.apiKey } : {}),
          ...(old.apiKeys !== undefined ? { apiKeys: old.apiKeys } : {}),
        };
      }
    }
    const { _keepKeyOf: _drop, ...rest } = route;
    return rest;
  });
  return { ...(input as Record<string, unknown>), routes };
}

export type SetConfigResult =
  | { ok: true; routes: ModelRoute[] }
  | { ok: false; error: string };

/** Validate + swap the live router. ConfigError text goes back to the UI. */
export function setConfig(input: unknown): SetConfigResult {
  try {
    const config = parseConfig(reattachStoredKeys(input));
    g.__aiRouterState = { router: new AIRouter(config), routes: config.routes };
    return { ok: true, routes: config.routes };
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Remove one route by id and swap the live router. */
export function removeRoute(id: string): SetConfigResult {
  const current = g.__aiRouterState?.routes;
  if (!current) return { ok: false, error: "no config to remove from" };
  const remaining = current.filter((r) => r.id !== id);
  if (remaining.length === current.length) {
    return { ok: false, error: `unknown route id "${id}"` };
  }
  if (remaining.length === 0) {
    return { ok: false, error: "cannot remove the last route" };
  }
  return setConfig({ routes: remaining });
}

function mask(key: string): string {
  return key.length <= 8 ? "•••" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Current routes with keys masked — safe to send to the UI. */
export function describeRoutes(): Array<Record<string, unknown>> {
  return ensure().routes.map((r) => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    baseUrl: r.baseUrl,
    maxRetries: r.maxRetries,
    timeoutMs: r.timeoutMs,
    limit: r.limit,
    keys:
      r.apiKey !== undefined || r.apiKeys !== undefined
        ? [...(r.apiKey ? [mask(r.apiKey)] : []), ...(r.apiKeys ?? []).map(mask)]
        : [],
  }));
}
