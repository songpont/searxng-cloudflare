import type { Env } from "../env";
import { searchTavily, extractTavily, type TavilyResult, type TavilyTimeRange } from "./tavily";
import { parseFeed } from "./rss";
import { fetchArticle, fetchHtml, MAX_LENGTH } from "./article-content";
import { looksLikeGenericLabel, titleFromContent, titleFromQueryParam, parseThaiReportDate } from "./sources/pdf-reports";
import { archiveDocument } from "./pdf-archive";
import sourcesFile from "../../config/sources.json";

/**
 * Tavily pads a domain-restricted query out to max_results even when little
 * genuinely matches, rather than returning fewer results — those padding hits
 * are near-random with respect to the query. Measured against our own keyword
 * set (2026-09-05): real matches scored >= ~0.16 (often much higher), while
 * padding noise topped out around 0.05. 0.1 sits in that gap with margin.
 */
const MIN_RELEVANCE_SCORE = 0.1;

function relevant(results: TavilyResult[]): TavilyResult[] {
  return results.filter((r) => (r.score ?? 1) >= MIN_RELEVANCE_SCORE);
}

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
  /**
   * type: page — use this list instead of the global keywords for matchKeywords
   * on this source. The global keywords are full search-query phrases (river +
   * pollution word together, e.g. "แม่น้ำกก สารพิษ") — right for narrowing a
   * search engine query, but too strict for matching a title/report name that
   * just names the river without a pollution word attached (a report titled
   * "รายงานคุณภาพน้ำแม่น้ำกก ครั้งที่ 20" is obviously relevant but contains
   * none of those 2-word phrases verbatim). Use bare place/river names here.
   */
  titleKeywords?: string[];
  /** type: page — the harvested links are PDFs (or similar): fetch full text via Tavily's /extract instead of our own HTML-only fetch, and derive title/date from that text when the listing page's own link text/markup doesn't carry them. */
  usePdfExtract?: boolean;
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

/** Which fetch mechanism produced the row — shown as a tag in the dashboard. 'searxng' is reserved; nothing inserts it today. */
type Engine = "rss" | "page" | "tavily" | "searxng";

interface NewArticle {
  url: string;
  title: string;
  snippet: string;
  sourceId: string;
  sourceName: string;
  trust: string;
  engine: Engine;
  keyword?: string;
  publishedAt?: string;
  /** Set from source.usePdfExtract — tells enrichWithFullText to run this URL through Tavily's /extract even though engine isn't "tavily", and to derive title/date from the extracted text. Never persisted (insertArticle only binds its own named fields). */
  useTavilyExtract?: boolean;
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

/** Tavily has no from/to filter, only these buckets — pick the tightest that still covers the cutoff. */
function maxAgeToTimeRange(days?: number): TavilyTimeRange | undefined {
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
 * full text, and fills in a publish date from the page markup when the
 * feed/search result gave none. Two sources of full text are tried and the
 * longer result kept, since each succeeds on pages the other is blocked on
 * (JS-rendered pages, bot-blocking, gzip quirks, etc):
 *
 *  1. Tavily's /extract endpoint, but ONLY for engine: "tavily" candidates,
 *     and only ones that already survived every other filter (domain match,
 *     MIN_RELEVANCE_SCORE, recency) — it's billed per URL (1 credit/5), so
 *     paying for a page we were going to discard anyway would be wasted spend.
 *     This is deliberately a separate call from search, not
 *     search's own include_raw_content — that bills per URL *returned* by
 *     search (up to max_results), before any of our filtering.
 *  2. Our own fetch (article-content.ts) — free, tried for every candidate
 *     regardless of engine.
 */
async function enrichWithFullText(env: Env, candidates: NewArticle[]): Promise<NewArticle[]> {
  const tavilyUrls = [
    ...new Set(candidates.filter((a) => a.engine === "tavily" || a.useTavilyExtract).map((a) => a.url)),
  ];
  const pdfUrls = [...new Set(candidates.filter((a) => a.useTavilyExtract).map((a) => a.url))];
  const [extracted] = await Promise.all([
    extractTavily(env, tavilyUrls),
    // Runs alongside the extract call, not blocking it — archival is a
    // best-effort side job (own copy in case the source link rots later),
    // not on the critical path for getting today's text.
    Promise.all(pdfUrls.map((url) => archiveDocument(env, url))),
  ]);

  return Promise.all(
    candidates.map(async (a) => {
      let snippet = a.snippet;
      let title = a.title;
      let publishedAt = a.publishedAt;

      const ext = extracted.get(a.url);
      if (ext && ext.length > snippet.length) snippet = ext.slice(0, MAX_LENGTH);
      // A PDF/doc listing page's link text is usually just a generic button
      // label ("ดาวน์โหลด"/"ดูออนไลน์"), not the document's actual title or
      // date — pull both from the extracted text itself instead.
      if (a.useTavilyExtract && ext) {
        if (looksLikeGenericLabel(title)) title = titleFromContent(ext) ?? title;
        publishedAt = publishedAt ?? parseThaiReportDate(ext);
      }

      // Our own fetch only understands HTML (article-content.ts bails on any
      // other content-type), so it's a no-op for PDFs — harmless to still try.
      const article = await fetchArticle(a.url);
      if (article && article.text.length > snippet.length) snippet = article.text;
      publishedAt = publishedAt ?? article?.publishedAt;

      return { ...a, snippet, title, publishedAt };
    }),
  );
}

/** Inserts the article if its URL is new; returns it (for downstream use) only when actually inserted. */
/**
 * Inserts a new URL, or — the one case an existing row is touched — fills in
 * a previously-empty snippet if this pass got real content where an earlier
 * one didn't (a PDF whose Tavily extraction failed before but succeeds this
 * time; the same listing re-surfaces the same URL every day, so this happens
 * for free on the next daily run with no separate retry job needed). Never
 * overwrites a row that already has content.
 */
async function insertArticle(env: Env, article: NewArticle): Promise<NewArticle | null> {
  const result = await env.river_watch_db
    .prepare(
      `INSERT INTO articles (url, title, snippet, source_id, source_name, trust, engine, keyword, published_at, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = excluded.title,
         snippet = excluded.snippet,
         published_at = COALESCE(articles.published_at, excluded.published_at)
       WHERE length(articles.snippet) = 0 AND length(excluded.snippet) > 0`,
    )
    .bind(
      article.url,
      article.title,
      article.snippet,
      article.sourceId,
      article.sourceName,
      article.trust,
      article.engine,
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
        engine: "rss",
        keyword,
        publishedAt: normalizeDate(item.pubDate),
      });
    }

    const enriched = await enrichWithFullText(env, candidates);
    return persist(env, enriched, maxAgeDaysFor(source));
  } catch (err) {
    console.error(`rss collect failed for ${source.id}`, err);
    return [];
  }
}

/** Bare hostname for Tavily's include_domains, which filters by host only (no path prefix). */
function hostOf(domainSpec: string): string {
  try {
    return new URL(domainSpec.startsWith("http") ? domainSpec : `https://${domainSpec}`).hostname;
  } catch {
    return domainSpec;
  }
}

function findSourceForUrl(url: string, siteSources: Source[]): Source | undefined {
  return siteSources.find((s) => urlMatchesDomain(url, s.domain!));
}

/** The loosest cutoff among these sources — any source with no cutoff means the search itself shouldn't be time-restricted (persist() still enforces each source's own cutoff afterward). */
function looseMaxAgeDays(sources: Source[]): number | undefined {
  let max = 0;
  for (const s of sources) {
    const d = maxAgeDaysFor(s);
    if (d === undefined) return undefined;
    max = Math.max(max, d);
  }
  return max;
}

/**
 * Runs one Tavily search per keyword covering every `type: site` source's
 * domain at once, instead of one search per source per keyword. Tavily charges
 * a flat rate per request regardless of how many domains are listed, so
 * consolidating this way cuts credit use roughly N-sources-fold for the same
 * coverage. Results are attributed back to the source whose domain they match.
 */
async function collectSitesForKeyword(env: Env, siteSources: Source[], keyword: string): Promise<NewArticle[]> {
  const domains = [...new Set(siteSources.map((s) => hostOf(s.domain!)))];
  const results = await searchTavily(env, keyword, {
    includeDomains: domains,
    timeRange: maxAgeToTimeRange(looseMaxAgeDays(siteSources)),
    topic: "news",
    // Tavily's cap (20) rather than the client default (10) — with dozens of
    // domains sharing one query, a small result count would let a few
    // high-traffic outlets crowd out the smaller/niche ones every time.
    maxResults: 20,
  });

  const candidates: NewArticle[] = [];
  for (const r of relevant(results)) {
    const source = findSourceForUrl(r.url, siteSources);
    if (!source) continue; // e.g. a path-restricted domain (facebook.com/SomePage) that this URL doesn't fall under
    candidates.push({
      url: r.url,
      title: r.title,
      snippet: (r.content ?? "").slice(0, 500),
      sourceId: source.id,
      sourceName: source.name,
      trust: source.trust,
      engine: "tavily",
      keyword,
      publishedAt: normalizeDate(r.published_date) ?? parseSnippetDate(r.content),
    });
  }
  return candidates;
}

async function collectFromTavilySites(env: Env, activeSources: Source[]): Promise<NewArticle[]> {
  const siteSources = activeSources.filter((s) => s.type === "site" && s.domain);
  if (siteSources.length === 0) return [];

  const results = await Promise.all(config.keywords.map((keyword) => collectSitesForKeyword(env, siteSources, keyword)));
  const enriched = await enrichWithFullText(env, results.flat());

  // Cutoff is per-article using its own source's maxAgeDays, which can differ
  // even though the search above shared one (loosest) time_range.
  const byId = new Map(siteSources.map((s) => [s.id, s]));
  const grouped = new Map<string, NewArticle[]>();
  for (const a of enriched) grouped.set(a.sourceId, [...(grouped.get(a.sourceId) ?? []), a]);

  const inserted: NewArticle[] = [];
  for (const [sourceId, articles] of grouped) {
    inserted.push(...(await persist(env, articles, maxAgeDaysFor(byId.get(sourceId)))));
  }
  return inserted;
}

const PAGE_LINK_LIMIT = 20;

/** Pulls <a href> links (absolute URL + visible text) out of a listing page's HTML. */
/**
 * A page's actual link-resolution base per HTML spec — its own URL, unless it
 * declares <base href="...">, which some government CMS sites do (this
 * project first hit it on a PCD regional office site whose listing emits
 * root-relative-looking hrefs like "th/download/?..." meant to resolve
 * against the site root, not the current page's path).
 */
function resolveBase(html: string, pageUrl: string): URL {
  const baseHref = html.match(/<base[^>]+href=(["'])(.*?)\1/i)?.[2];
  if (baseHref) {
    try {
      return new URL(baseHref, pageUrl);
    } catch {
      /* fall through to the page's own URL */
    }
  }
  return new URL(pageUrl);
}

function extractLinks(html: string, base: URL): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const seen = new Set<string>();
  // The quote character is captured and re-used to close the attribute (\1)
  // rather than blacklisting a fixed set of characters from the href value —
  // some sites emit literal, un-percent-encoded spaces and non-ASCII text
  // inside query strings, which a blacklist-based [^"'\s>]+ class would cut
  // off mid-value and then fail to find a closing quote for.
  for (const m of html.matchAll(/<a\s+[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = m[2].trim();
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
    const text = m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
    const base = resolveBase(html, source.url);
    const keywordList = source.titleKeywords ?? config.keywords;

    const candidates: NewArticle[] = [];
    for (const link of extractLinks(html, base)) {
      if (candidates.length >= PAGE_LINK_LIMIT) break;
      if (link.url === source.url) continue;
      if (!source.crossHost && new URL(link.url).host !== base.host) continue;
      if (source.include && !link.url.includes(source.include)) continue;
      const title = titleFromQueryParam(link.url) || link.text || link.url;
      const keyword = matchesKeyword(title, keywordList);
      // Drop only links whose (present, informative) title text clearly isn't
      // on topic; links with no useful title yet — a bare URL, or a generic
      // button label like "ดาวน์โหลด" on a document-listing page — are kept
      // for the post-fetch check below, since there's nothing to judge yet.
      const hasInformativeText = title !== link.url && !looksLikeGenericLabel(title);
      if (source.matchKeywords && hasInformativeText && !keyword) continue;
      candidates.push({
        url: link.url,
        title,
        snippet: "",
        sourceId: source.id,
        sourceName: source.name,
        trust: source.trust,
        engine: "page",
        keyword,
        useTavilyExtract: source.usePdfExtract,
      });
    }

    const enriched = await enrichWithFullText(env, candidates);
    const topical = source.matchKeywords
      ? enriched.filter((a) => matchesKeyword(`${a.title} ${a.snippet}`, keywordList))
      : enriched;

    return persist(env, topical, maxAgeDaysFor(source));
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

async function collectFollowUpQuery(env: Env, query: string, domains: string[]): Promise<NewArticle[]> {
  try {
    const maxAge = maxAgeDaysFor();
    const results = await searchTavily(env, query, {
      includeDomains: domains,
      timeRange: maxAgeToTimeRange(maxAge),
      topic: "general",
    });
    const candidates: NewArticle[] = relevant(results).slice(0, 5).map((r) => ({
      url: r.url,
      title: r.title,
      snippet: (r.content ?? "").slice(0, 500),
      sourceId: "ai-followup",
      sourceName: "ค้นเจาะลึกโดย AI (แหล่งข่าวเดิม)",
      trust: "web",
      engine: "tavily",
      keyword: query,
      publishedAt: normalizeDate(r.published_date) ?? parseSnippetDate(r.content),
    }));

    const enriched = await enrichWithFullText(env, candidates);
    return persist(env, enriched, maxAge);
  } catch (err) {
    console.error(`followup collect failed for "${query}"`, err);
    return [];
  }
}

/**
 * Round 2: an AI-guided dig based on what round 1 found, using queries round 1
 * never tried (company/mine names, place names, people) — but restricted to
 * the same `type: site` domains as round 1, not the open web. An unrestricted
 * search here previously let unrelated results through (e.g. a supermarket
 * chain's branch-locator page matching on a place name in the query) despite
 * MIN_RELEVANCE_SCORE — a scoped domain list is a much harder filter than a
 * relevance score against arbitrary web content. Still inserted as trust="web"
 * since the query terms themselves are AI-guessed and unvetted, unlike the
 * fixed keyword list.
 */
async function runFollowUpRound(
  env: Env,
  seedArticles: NewArticle[],
  domains: string[],
): Promise<{ queries: string[]; collected: number }> {
  if (seedArticles.length === 0 || !env.DEEPSEEK_API_KEY) return { queries: [], collected: 0 };
  const queries = await extractFollowUpQueries(env, seedArticles);
  if (queries.length === 0) return { queries: [], collected: 0 };
  const results = await Promise.all(queries.map((q) => collectFollowUpQuery(env, q, domains)));
  return { queries, collected: results.flat().length };
}

export async function runDailyCollection(env: Env): Promise<{
  broadCollected: number;
  sourcesRun: number;
  followUpQueries: string[];
  followUpCollected: number;
}> {
  const activeSources = config.sources.filter((s) => s.enabled !== false);
  const feedResults = await Promise.all(
    activeSources
      .filter((s) => s.type !== "site")
      .map((source) => (source.type === "rss" ? collectFromRss(env, source) : collectFromPage(env, source))),
  );
  const siteResults = await collectFromTavilySites(env, activeSources);
  const broadArticles = [...feedResults.flat(), ...siteResults];

  const siteDomains = [
    ...new Set(activeSources.filter((s) => s.type === "site" && s.domain).map((s) => hostOf(s.domain!))),
  ];
  const followUp = await runFollowUpRound(env, broadArticles, siteDomains);

  return {
    broadCollected: broadArticles.length,
    sourcesRun: activeSources.length,
    followUpQueries: followUp.queries,
    followUpCollected: followUp.collected,
  };
}
