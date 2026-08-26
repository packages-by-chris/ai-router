/**
 * CLI entrypoint.
 *
 *   ROUTER_CONFIG    path to a router config JSON file, or an inline JSON string (required)
 *   GATEWAY_API_KEY  Bearer key clients must present (required unless GATEWAY_INSECURE=1)
 *   GATEWAY_PORT     listen port (default 8787)
 *
 * Config files may reference env vars as ${OPENAI_API_KEY} — parseConfig
 * interpolates them from this process's environment.
 */

import { readFileSync } from "node:fs";
import { AIRouter } from "@ai-router/core";
import { createGatewayServer } from "./server.js";

function loadConfig(): unknown {
  const source = process.env.ROUTER_CONFIG;
  if (!source) {
    console.error("gateway: ROUTER_CONFIG is required (path to config JSON or inline JSON)");
    process.exit(1);
  }
  const raw = source.trimStart().startsWith("{")
    ? source
    : readFileSync(source, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`gateway: ROUTER_CONFIG is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
}

const apiKey = process.env.GATEWAY_API_KEY;
const insecure = process.env.GATEWAY_INSECURE === "1";
if (!apiKey && !insecure) {
  console.error("gateway: GATEWAY_API_KEY is required (or set GATEWAY_INSECURE=1 for local dev)");
  process.exit(1);
}
if (insecure) console.warn("gateway: auth DISABLED via GATEWAY_INSECURE=1 — never expose this");

const router = new AIRouter(loadConfig());
const port = Number(process.env.GATEWAY_PORT ?? 8787);

createGatewayServer({ router, ...(apiKey !== undefined ? { apiKey } : { allowNoAuth: true }) }).listen(
  port,
  () => {
    console.log(`gateway: listening on http://127.0.0.1:${port}/v1`);
    console.log(`gateway: routes (${router.routes.length}): ${router.routes.join(", ")}`);
  },
);
