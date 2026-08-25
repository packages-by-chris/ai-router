import {
  AIRouter,
  ConfigError,
  parseConfig,
  type LimitRule,
  type ModelRoute,
  type RouterConfig,
  type RoutingStrategy,
} from "@ai-router/core";

/**
 * Router state for the demo.
 *
 * Routes are configurable from the frontend (POST /api/config) and
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
  strategy?: RoutingStrategy;
  /** Demo USD-per-1M-token prices keyed by route id (drives cost routing). */
  pricing: Record<string, { input: number; output: number }>;
}

const g = globalThis as typeof globalThis & { __aiRouterState?: RouterState };

/** Single source of truth for router options — used by every construction site. */
function makeRouter(
  config: RouterConfig,
  pricing: Record<string, { input: number; output: number }>,
): AIRouter {
  return new AIRouter(config, {
    circuitBreaker: { threshold: 5, cooldownMs: 30_000 },
    pricing,
    middleware: {
      beforeRequest(ctx) {
        console.log(`[ai-router] → ${ctx.routeId} (${ctx.provider}/${ctx.model}) attempt #${ctx.attempt}`);
      },
      afterResponse(ctx, res) {
        console.log(`[ai-router] ← ${ctx.routeId} ok — ${res.usage?.total_tokens ?? "?"} tokens`);
      },
    },
  });
}

function ensure(): RouterState {
  if (!g.__aiRouterState) {
    g.__aiRouterState = { router: makeRouter({ routes: [] }, {}), routes: [], pricing: {} };
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
  | { ok: true; routes: ModelRoute[]; strategy?: RoutingStrategy }
  | { ok: false; error: string };

/**
 * Validate + swap the live router. ConfigError text goes back to the UI.
 * Body may carry demo `pricing` ({ routeId: [usdPerMIn, usdPerMOut] }) for
 * cost-aware routing; omitted pricing persists from the previous state.
 */
export function setConfig(input: unknown): SetConfigResult {
  try {
    const config = parseConfig(reattachStoredKeys(input));
    const incoming = (input ?? {}) as {
      pricing?: Record<string, [number, number]>;
    };
    const prev = g.__aiRouterState?.pricing ?? {};
    const source =
      incoming.pricing !== undefined
        ? incoming.pricing
        : Object.fromEntries(
            Object.entries(prev).map(([k, v]) => [k, [v.input, v.output] as [number, number]]),
          );
    const pricing: Record<string, { input: number; output: number }> = {};
    for (const [routeId, pair] of Object.entries(source)) {
      if (
        Array.isArray(pair) &&
        pair.length >= 2 &&
        pair.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
      ) {
        pricing[routeId] = { input: pair[0]!, output: pair[1]! };
      }
    }
    g.__aiRouterState = {
      router: makeRouter(config, pricing),
      routes: config.routes,
      strategy: config.strategy,
      pricing,
    };
    return { ok: true, routes: config.routes, strategy: config.strategy };
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

/** What GET /api/config returns per route (keys masked server-side). */
export interface ServerRouteDTO {
  id: string;
  /** Built-in id, preset id, or registered adapter id. */
  provider: string;
  model: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  limit?: LimitRule;
  weight?: number;
  capabilities?: ModelRoute["capabilities"];
  keys: string[];
}

/** Current routes with keys masked — safe to send to the UI. */
export function describeRoutes(): ServerRouteDTO[] {
  return ensure().routes.map((r) => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    baseUrl: r.baseUrl,
    maxRetries: r.maxRetries,
    timeoutMs: r.timeoutMs,
    limit: r.limit,
    weight: r.weight,
    capabilities: r.capabilities,
    keys:
      r.apiKey !== undefined || r.apiKeys !== undefined
        ? [...(r.apiKey ? [mask(r.apiKey)] : []), ...(r.apiKeys ?? []).map(mask)]
        : [],
  }));
}

/** Current demo state summary (no credentials). */
export function describeState(): {
  routes: ServerRouteDTO[];
  strategy?: RoutingStrategy;
  pricing: Record<string, { input: number; output: number }>;
} {
  const state = ensure();
  return {
    routes: describeRoutes(),
    ...(state.strategy !== undefined ? { strategy: state.strategy } : {}),
    pricing: state.pricing,
  };
}
