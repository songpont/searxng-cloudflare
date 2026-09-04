import type { Env } from "../env";
import { searchAutomated, type TimeRange } from "../search";
import { parseFeed } from "./rss";
import { fetchArticle, fetchHtml } from "./article-content";
import sourcesFile from "../../config/sources.json";

interface Source {
  id: string;
  name: string;
  type: "rss" | "site" | "page";
  trust: "official" | "news" | "social";
  enabled?: boolean;
  url?: string;
  domain?: string;
  note?: string;
  /** type: page — only follow links whose absolute URL contains this substring (e.g. "/news/"). */
  include?: string;
  /** type: page — follow links to other hosts too (default: same host as the page only). */
  crossHost?: boolean;
  /** type: page — require the link text to match one of the global keywords (default: take every link). */
  matchKeywords?: boolean;
  /** Drop articles whose known publish date is older than this many days. Overrides the top-level maxAgeDays. */
  maxAgeDays?: number;
}

interface SourcesConfig {
  keywords: string[];
  sources: Source[];
  /** Global recency cutoff (days) applied to every source; a source's own maxAgeDays wins. Omit or 0 = no cutoff. */
  maxAgeDays?: number;
}

const config = sourcesFile as unknown as SourcesConfig;

interface NewArticle {
  url: string;
  title: string;
  snippet: string;
  sourceId: string;
  sourceName: string;
  trust: string;
  keyword?: string;
  publishedAt?: string;
}

function matchesKeyword(text: string, keywords: string[]): string | undefined {
  const lower = text.toLowerCase();
  return keywords.find((k) => lower.includes(k.toLowerCase()));
}

/** The source's own cutoff, else the global one. */
function maxAgeDaysFor(source?: Source): number | undefined {
  const days = source?.maxAgeDays ?? config.maxAgeDays;
  return days && days > 0 ? days : undefined;
}

/** SearXNG has no from/to filter, only these buckets — pick the tightest that still covers the cutoff. */
function maxAgeToTimeRange(days?: number): TimeRange | undefined {
  if (!days) return undefined;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  return "year";
}

/** Keep articles with no known date (can't prove they're stale) and those newer than the cutoff. */
function withinMaxAge(publishedAt: string | undefined, days?: number): boolean {
  if (!days || !publishedAt) return true;
  const t = Date.parse(publishedAt);
  return isNaN(t) || t >= Date.now() - days * 86_400_000;
}

/**
 * RSS <pubDate> comes in RFC-822 form (e.g. "Tue, 03 Sep 2026 ..."), while
 * search-result publishedDate is usually already ISO-ish. Both get normalized
 * to ISO 8601 so the weekly summarizer can do a plain string range comparison
 * against published_at in SQLite.
 */
function normalizeDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = new Date(raw).getTime();
  if (isNaN(t) || t < Date.parse("2000-01-01") || t > Date.now() + 2 * 86_400_000) return undefined;
  return new Date(t).toISOString();
}

/**
 * SearXNG/Google frequently put the page date at the front of a result's
 * content string instead of in the publishedDate field ("Nov 27, 2025 · ...",
 * "27 Nov 2025 ...", "2025. 11. 25. · ..."). Pull that leading token when the
 * structured field is missing.
 */
function parseSnippetDate(content?: string): string | undefined {
  const s = content?.trimStart();
  if (!s) return undefined;

  const monthDayYear = s.match(/^([A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+\d{4})\b/);
  if (monthDayYear) return normalizeDate(monthDayYear[1]);

  const dayMonthYear = s.match(/^(\d{1,2}\s+[A-Z][a-z]{2,8}\.?\s+\d{4})\b/);
  if (dayMonthYear) return normalizeDate(dayMonthYear[1]);

  const ymd = s.match(/^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\b/);
  if (ymd) return normalizeDate(`${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`);

  return undefined;
}

function urlMatchesDomain(url: string, domainSpec: string): boolean {
  try {
    const target = new URL(domainSpec.startsWith("http") ? domainSpec : `https://${domainSpec}`);
    const actual = new URL(url);
    const hostMatches = actual.hostname === target.hostname || actual.hostname.endsWith(`.${target.hostname}`);
    if (!hostMatches) return false;
    if (target.pathname && target.pathname !== "/") {
      return actual.pathname.toLowerCase().startsWith(target.pathname.toLowerCase());
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces each candidate's thin search/RSS snippet with the article's own
 * lead paragraphs when the fetch succeeds, and fills in a publish date from the
 * page markup when the feed/search result gave none. Run in parallel across the
 * batch; falls back to the original snippet on any failure (blocked, JS-rendered
 * page with no server HTML, timeout, etc) rather than dropping the article.
 */
async function enrichWithFullText(candidates: NewArticle[]): Promise<NewArticle[]> {
  return Promise.all(
    candidates.map(async (a) => {
      const article = await fetchArticle(a.url);
      if (!article) return a;
      return { ...a, snippet: article.text, publishedAt: a.publishedAt ?? article.publishedAt };
    }),
  );
}

/** Inserts the article if its URL is new; returns it (for downstream use) only when actually inserted. */
async function insertArticle(env: Env, article: NewArticle): Promise<NewArticle | null> {
  const result = await env.river_watch_db
    .prepare(
      `INSERT OR IGNORE INTO articles (url, title, snippet, source_id, source_name, trust, keyword, published_at, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      article.url,
      article.title,
      article.snippet,
      article.sourceId,
      article.sourceName,
      article.trust,
      article.keyword ?? null,
      article.publishedAt ?? null,
      new Date().toISOString(),
    )
    .run();
  return (result.meta.changes ?? 0) > 0 ? article : null;
}

/** Drops anything past the recency cutoff, then inserts the rest; returns those actually stored. */
async function persist(env: Env, articles: NewArticle[], maxAgeDays?: number): Promise<NewArticle[]> {
  const inserted: NewArticle[] = [];
  for (const article of articles) {
    if (!withinMaxAge(article.publishedAt, maxAgeDays)) continue;
    const added = await insertArticle(env, article);
    if (added) inserted.push(added);
  }
  return inserted;
}

async function collectFromRss(env: Env, source: Source): Promise<NewArticle[]> {
  if (!source.url) return [];
  try {
    const res = await fetch(source.url, { headers: { "user-agent": "river-watch-bot/1.0" } });
    if (!res.ok) return [];
    const items = parseFeed(await res.text());

    const candidates: NewArticle[] = [];
    for (const item of items) {
      const keyword = matchesKeyword(`${item.title} ${item.description}`, config.keywords);
      if (!keyword) continue;
      candidates.push({
        url: item.link,
        title: item.title,
        snippet: item.description.slice(0, 500),
        sourceId: source.id,
        sourceName: source.name,
        trust: source.trust,
        keyword,
        publishedAt: normalizeDate(item.pubDate),
      });
    }

    const enriched = await enrichWithFullText(candidates);
    return persist(env, enriched, maxAgeDaysFor(source));
  } catch (err) {
    console.error(`rss collect failed for ${source.id}`, err);
    return [];
  }
}

async function collectFromSiteKeyword(env: Env, source: Source, keyword: string): Promise<NewArticle[]> {
  try {
    const maxAge = maxAgeDaysFor(source);
    const res = await searchAutomated(
      env,
      `${keyword} site:${source.domain}`,
      ["google"],
      maxAgeToTimeRange(maxAge),
    );
    const data = (await res.json()) as {
      results?: { url: string; title: string; content?: string; publishedDate?: string }[];
    };
    const relevant = (data.results ?? []).filter((r) => urlMatchesDomain(r.url, source.domain!));
    const candidates: NewArticle[] = relevant.slice(0, 5).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: (r.content ?? "").slice(0, 500),
      sourceId: source.id,
      sourceName: source.name,
      trust: source.trust,
      keyword,
      publishedAt: normalizeDate(r.publishedDate) ?? parseSnippetDate(r.content),
    }));

    const enriched = await enrichWithFullText(candidates);
    return persist(env, enriched, maxAge);
  } catch (err) {
    console.error(`site collect failed for ${source.id}/${keyword}`, err);
    return [];
  }
}

async function collectFromSite(env: Env, source: Source): Promise<NewArticle[]> {
  if (!source.domain) return [];
  const results = await Promise.all(config.keywords.map((keyword) => collectFromSiteKeyword(env, source, keyword)));
  return results.flat();
}

const PAGE_LINK_LIMIT = 20;

/** Pulls <a href> links (absolute URL + visible text) out of a listing page's HTML. */
function extractLinks(html: string, base: URL): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\s+[^>]*href=["']([^"'\s>]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = m[1].trim();
    if (!raw || /^(?:javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    let url: string;
    try {
      const u = new URL(raw, base);
      u.hash = "";
      url = u.toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push({ url, text });
  }
  return out;
}

/**
 * Reads a specific page (a tag/section/listing page that has no RSS feed) and
 * treats the article links on it as the candidate set — no search engine in the
 * loop. Enrichment then pulls each article's own text and date.
 *
 * Best for server-rendered listings. A JS-rendered page ships only a shell, so
 * the links found are generic nav/"popular" items rather than the real list —
 * set `matchKeywords: true` there so the fetched article text still gets a
 * relevance check, or use a `type: site` source instead.
 */
async function collectFromPage(env: Env, source: Source): Promise<NewArticle[]> {
  if (!source.url) return [];
  try {
    const html = await fetchHtml(source.url);
    if (!html) return [];
    const base = new URL(source.url);

    const candidates: NewArticle[] = [];
    for (const link of extractLinks(html, base)) {
      if (candidates.length >= PAGE_LINK_LIMIT) break;
      if (link.url === source.url) continue;
      if (!source.crossHost && new URL(link.url).host !== base.host) continue;
      if (source.include && !link.url.includes(source.include)) continue;
      const keyword = matchesKeyword(link.text, config.keywords);
      // Drop only links whose (present) text clearly isn't on topic; links with
      // no visible text are kept for the post-fetch check below.
      if (source.matchKeywords && link.text && !keyword) continue;
      candidates.push({
        url: link.url,
        title: link.text || link.url,
        snippet: "",
        sourceId: source.id,
        sourceName: source.name,
        trust: source.trust,
        keyword,
      });
    }

    const enriched = await enrichWithFullText(candidates);
    const relevant = source.matchKeywords
      ? enriched.filter((a) => matchesKeyword(`${a.title} ${a.snippet}`, config.keywords))
      : enriched;

    return persist(env, relevant, maxAgeDaysFor(source));
  } catch (err) {
    console.error(`page collect failed for ${source.id}`, err);
    return [];
  }
}

const FOLLOWUP_SYSTEM_PROMPT = `คุณคือผู้ช่วยนักข่าวสืบสวนด้านสิ่งแวดล้อม จากหัวข้อข่าวและบทคัดย่อที่ให้มา
ให้ระบุคำค้นเจาะจงเพิ่มเติม 3-5 คำ เพื่อขุดข้อมูลเชิงลึกต่อในเว็บเปิด เช่น ชื่อบริษัท/เหมืองที่ถูกพาดพิง
ชื่อหน่วยงานที่รับผิดชอบ ชื่อสถานที่/หมู่บ้านที่ได้รับผลกระทบ หรือชื่อบุคคล/นักเคลื่อนไหวที่เกี่ยวข้อง
ห้ามใช้คำค้นที่ซ้ำหรือกว้างเกินไปแบบเดียวกับหัวข้อข่าวที่ให้มาเฉยๆ ต้องเจาะจงกว่าเดิม
ตอบเป็น JSON เท่านั้น รูปแบบ: {"queries": ["คำค้น 1", "คำค้น 2", ...]}`;

async function extractFollowUpQueries(env: Env, seedArticles: NewArticle[]): Promise<string[]> {
  const context = seedArticles
    .slice(0, 20)
    .map((a, i) => `${i + 1}. ${a.title} — ${a.snippet}`)
    .join("\n");

  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: FOLLOWUP_SYSTEM_PROMPT },
          { role: "user", content: context },
        ],
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(data.choices[0].message.content) as { queries?: string[] };
    return (parsed.queries ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, 5);
  } catch (err) {
    console.error("extractFollowUpQueries failed", err);
    return [];
  }
}

async function collectFollowUpQuery(env: Env, query: string): Promise<NewArticle[]> {
  try {
    const maxAge = maxAgeDaysFor();
    const res = await searchAutomated(env, query, [], maxAgeToTimeRange(maxAge));
    const data = (await res.json()) as {
      results?: { url: string; title: string; content?: string; publishedDate?: string }[];
    };
    const candidates: NewArticle[] = (data.results ?? []).slice(0, 5).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: (r.content ?? "").slice(0, 500),
      sourceId: "ai-followup",
      sourceName: "ค้นเจาะลึกโดย AI (เว็บเปิด)",
      trust: "web",
      keyword: query,
      publishedAt: normalizeDate(r.publishedDate) ?? parseSnippetDate(r.content),
    }));

    const enriched = await enrichWithFullText(candidates);
    return persist(env, enriched, maxAge);
  } catch (err) {
    console.error(`followup collect failed for "${query}"`, err);
    return [];
  }
}

/**
 * Round 2: an open-web, AI-guided dig based on what round 1 found. Unlike the
 * fixed keyword/source sweep, these queries and the sites they land on are
 * not vetted — inserted with trust="web" so the summarizer (and the UI) can
 * clearly flag them as unverified rather than mixing them in with official/news.
 */
async function runFollowUpRound(env: Env, seedArticles: NewArticle[]): Promise<{ queries: string[]; collected: number }> {
  if (seedArticles.length === 0 || !env.DEEPSEEK_API_KEY) return { queries: [], collected: 0 };
  const queries = await extractFollowUpQueries(env, seedArticles);
  if (queries.length === 0) return { queries: [], collected: 0 };
  const results = await Promise.all(queries.map((q) => collectFollowUpQuery(env, q)));
  return { queries, collected: results.flat().length };
}

export async function runDailyCollection(env: Env): Promise<{
  broadCollected: number;
  sourcesRun: number;
  followUpQueries: string[];
  followUpCollected: number;
}> {
  const activeSources = config.sources.filter((s) => s.enabled !== false);
  const roundResults = await Promise.all(
    activeSources.map((source) => {
      if (source.type === "rss") return collectFromRss(env, source);
      if (source.type === "page") return collectFromPage(env, source);
      return collectFromSite(env, source);
    }),
  );
  const broadArticles = roundResults.flat();

  const followUp = await runFollowUpRound(env, broadArticles);

  return {
    broadCollected: broadArticles.length,
    sourcesRun: activeSources.length,
    followUpQueries: followUp.queries,
    followUpCollected: followUp.collected,
  };
}
