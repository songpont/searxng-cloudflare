import type { Env } from "../env";

/** Tavily only offers these coarse buckets — same vocabulary as SearXNG's time_range, no arbitrary from/to. */
export type TavilyTimeRange = "day" | "week" | "month" | "year";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  /** RFC-822-ish string (e.g. "Sun, 24 May 2026 00:00:00 GMT") when Tavily could determine one — present on most results in practice, despite not being documented in the public API reference. */
  published_date?: string;
  /** Tavily's own relevance score, 0–1. Low-confidence padding results (Tavily fills up to max_results even when little truly matches) tend to sit well under 0.1 — see MIN_RELEVANCE_SCORE in collector.ts. */
  score?: number;
}

interface TavilySearchOptions {
  /** Restrict to these hostnames — Tavily charges the same flat rate no matter how many, so one query can cover every source at once. */
  includeDomains?: string[];
  timeRange?: TavilyTimeRange;
  /** "news" biases toward current-events coverage; "general" is the safer default when a source isn't mainstream-news-shaped (e.g. a government press-release page). */
  topic?: "news" | "general";
  maxResults?: number;
}

/**
 * A Tavily search request costs a flat 1 API credit at search_depth "basic"
 * regardless of include_domains size or topic — so collecting several sources
 * through one call with include_domains is free relative to querying them
 * separately, unlike SearXNG's per-request-per-engine model.
 */
export async function searchTavily(
  env: Env,
  query: string,
  { includeDomains, timeRange, topic = "general", maxResults = 10 }: TavilySearchOptions = {},
): Promise<TavilyResult[]> {
  if (!env.TAVILY_API_KEY) return [];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        topic,
        max_results: maxResults,
        ...(includeDomains?.length ? { include_domains: includeDomains } : {}),
        ...(timeRange ? { time_range: timeRange } : {}),
      }),
    });
    if (!res.ok) {
      console.error(`tavily search failed (${res.status}) for "${query}": ${await res.text()}`);
      return [];
    }
    const data = (await res.json()) as { results?: TavilyResult[] };
    return data.results ?? [];
  } catch (err) {
    console.error(`tavily search errored for "${query}"`, err);
    return [];
  }
}
