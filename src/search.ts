import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export class SearxngContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";

  constructor(ctx: DurableObject["ctx"], env: Env) {
    super(ctx, env);
    // SearXNG reads server.secret_key from SEARXNG_SECRET when set, overriding
    // the placeholder baked into settings.yml. Kept out of the image so the
    // real signing key never lands in git or a container layer.
    if (env.SEARXNG_SECRET) {
      this.envVars = { ...this.envVars, SEARXNG_SECRET: env.SEARXNG_SECRET };
    }
  }
}

export interface SearchConfig {
  language: string;
  safeSearch: 0 | 1 | 2;
  categories: string[];
  engines: string[];
}

const DEFAULT_CONFIG: SearchConfig = {
  language: "auto",
  safeSearch: 0,
  categories: ["general"],
  engines: [],
};

// The automated news collector must never inherit whatever the admin happens
// to have toggled via /api/chat or /api/config for their own manual testing
// (e.g. forcing language="th" silently zeroes out English-language follow-up
// queries). It always searches from these fixed defaults, only overriding
// `engines` when a caller needs a specific one (e.g. "google" for `site:`).
const AUTOMATION_DEFAULTS: SearchConfig = { ...DEFAULT_CONFIG };

export class ConfigStore extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") {
      const patch = (await request.json()) as Partial<SearchConfig>;
      const current = (await this.ctx.storage.get<SearchConfig>("config")) ?? DEFAULT_CONFIG;
      const next: SearchConfig = { ...current, ...patch };
      await this.ctx.storage.put("config", next);
      return Response.json(next);
    }

    const current = (await this.ctx.storage.get<SearchConfig>("config")) ?? DEFAULT_CONFIG;
    return Response.json(current);
  }
}

const INSTANCE_NAMES = ["primary", "secondary"];

export async function getConfig(env: Env): Promise<SearchConfig> {
  const stub = env.CONFIG_STORE.getByName("singleton");
  const res = await stub.fetch("http://config/");
  return res.json();
}

export async function patchConfig(env: Env, patch: Partial<SearchConfig>): Promise<SearchConfig> {
  const stub = env.CONFIG_STORE.getByName("singleton");
  const res = await stub.fetch("http://config/", {
    method: "POST",
    body: JSON.stringify(patch),
  });
  return res.json();
}

function buildSearchUrl(q: string, config: SearchConfig): string {
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("format", "json");
  if (config.language && config.language !== "auto") params.set("language", config.language);
  params.set("safesearch", String(config.safeSearch));
  if (config.categories.length) params.set("categories", config.categories.join(","));
  if (config.engines.length) params.set("engines", config.engines.join(","));
  return `http://searxng/search?${params.toString()}`;
}

/**
 * Sends a raw, fully-formed search URL to whichever container instance answers
 * first, with failover. Each SearXNG process tracks its own engine-suspension
 * state independently (in-memory), so "primary" can have Google/Bing suspended
 * while "secondary" is fine — this is the actual payoff of running two
 * instances. That only works if a 200-with-zero-results-because-everything-is-
 * suspended is treated as a soft failure worth trying the other instance on,
 * rather than as success (an HTTP-status-only check would never fail over here).
 */
export async function searchContainers(env: Env, url: string): Promise<Response> {
  const order = Math.random() < 0.5 ? INSTANCE_NAMES : [...INSTANCE_NAMES].reverse();

  let lastError: unknown;
  let degradedResponse: Response | null = null;

  for (const name of order) {
    try {
      const container = getContainer(env.SEARXNG_CONTAINER, name);
      const res = await container.fetch(new Request(url));
      if (!res.ok) {
        lastError = new Error(`instance "${name}" responded ${res.status}`);
        continue;
      }

      const body = (await res.clone().json()) as { results?: unknown[]; unresponsive_engines?: unknown[] };
      const allEnginesDown = (body.results?.length ?? 0) === 0 && (body.unresponsive_engines?.length ?? 0) > 0;
      if (!allEnginesDown) return res;
      degradedResponse = res;
    } catch (err) {
      lastError = err;
    }
  }

  // Both instances degraded (or one degraded, one errored) — a suspended-engines
  // response is still more useful to the caller than a bare 502.
  if (degradedResponse) return degradedResponse;

  return Response.json(
    { error: "all searxng instances failed", detail: String(lastError) },
    { status: 502 },
  );
}

export async function runSearch(env: Env, q: string): Promise<Response> {
  const config = await getConfig(env);
  return searchContainers(env, buildSearchUrl(q, config));
}

/** Used by the news collector only — fixed defaults regardless of the admin's stored config, with an optional engines override (e.g. "google" so `site:` is actually honored). */
export async function searchAutomated(env: Env, q: string, engines: string[] = []): Promise<Response> {
  return searchContainers(env, buildSearchUrl(q, { ...AUTOMATION_DEFAULTS, engines }));
}
