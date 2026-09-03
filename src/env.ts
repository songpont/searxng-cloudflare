import type { SearxngContainer, ConfigStore } from "./search";

export interface Env {
  SEARXNG_CONTAINER: DurableObjectNamespace<SearxngContainer>;
  CONFIG_STORE: DurableObjectNamespace<ConfigStore>;
  river_watch_db: D1Database;
  ASSETS: Fetcher;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL: string;
  ADMIN_TOKEN?: string;
  SEARXNG_SECRET?: string;
}
