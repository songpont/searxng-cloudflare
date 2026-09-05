import type { SearxngContainer, ConfigStore } from "./search";

export interface Env {
  SEARXNG_CONTAINER: DurableObjectNamespace<SearxngContainer>;
  CONFIG_STORE: DurableObjectNamespace<ConfigStore>;
  river_watch_db: D1Database;
  /** Durable copies of PDFs harvested by usePdfExtract sources — the source .go.th site is the only other copy, and government sites reorganize/delete without notice. */
  PDF_ARCHIVE: R2Bucket;
  ASSETS: Fetcher;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL: string;
  ADMIN_TOKEN?: string;
  SEARXNG_SECRET?: string;
  TAVILY_API_KEY?: string;
}
