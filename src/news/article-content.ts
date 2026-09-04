const FETCH_TIMEOUT_MS = 8000;
const MAX_LENGTH = 2500;
const MIN_LENGTH = 200;

function decodeEntities(html: string): string {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'");
}

// Short function words as they look when a run of English prose has been
// reversed character-by-character ("the" -> "eht"). Bangkok Post does this to
// the article body and flips it back visually with CSS
// (unicode-bidi: bidi-override; direction: rtl), so a raw-HTML reader gets
// mirror text. Counting these against their normal spellings tells us whether
// a given line is reversed.
const REVERSED_WORDS = /(?<![a-z])(eht|dna|fo|ot|ni|si|saw|era|no|yb|rof|taht|htiw|siht|dias)(?![a-z])/gi;
const FORWARD_WORDS = /(?<![a-z])(the|and|of|to|in|is|was|are|on|by|for|that|with|this|said)(?![a-z])/gi;

function reversedScore(s: string): number {
  return (s.match(REVERSED_WORDS) ?? []).length;
}
function forwardScore(s: string): number {
  return (s.match(FORWARD_WORDS) ?? []).length;
}

/** True when the text still reads as reversed English overall — used to reject a page we couldn't recover. */
function looksReversed(text: string): boolean {
  const r = reversedScore(text);
  return r >= 5 && r > forwardScore(text) * 2;
}

/**
 * Undo per-line character-reversal obfuscation. A full-line reversal restores
 * word order, spacing and punctuation in one go, so we only need to decide,
 * line by line, whether that line is reversed and flip the ones that are —
 * leaving an unobfuscated lead paragraph on its own line untouched.
 */
function deobfuscate(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.length > 20 && reversedScore(line) >= 3 && reversedScore(line) > forwardScore(line)
        ? [...line].reverse().join("")
        : line,
    )
    .join("\n");
}

/**
 * Crude readability-style extraction: strip obvious non-content blocks, prefer
 * an <article> element if present, then join paragraph text. No DOMParser is
 * available in Workers, so this is regex-based rather than a real DOM walk —
 * good enough to pull the lead paragraphs out of typical news page markup,
 * not meant to handle every layout.
 */
function extractArticleText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");

  const articleMatch = stripped.match(/<article[\s\S]*?<\/article>/i);
  const scope = articleMatch ? articleMatch[0] : stripped;

  const paragraphs = scope.match(/<p[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  const text = decodeEntities(paragraphs.map((p) => p.replace(/<[^>]+>/g, " ")).join("\n"))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return deobfuscate(text);
}

/**
 * Reads the response body as text, decompressing first when the bytes are
 * gzip/deflate. The Workers runtime normally decompresses subrequest responses
 * itself, but some origins (e.g. Bangkok Post, behind ByteArk) return
 * `Content-Encoding: gzip` unconditionally — even when the runtime never
 * negotiated it — and that raw gzip reaches us here. Reading such a body with
 * res.text() yields binary garbage, which then gets stored as the snippet.
 * We detect the gzip magic number (0x1f 0x8b) directly rather than trusting the
 * header, so a body the runtime already decompressed is passed through as-is.
 */
async function readBody(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());

  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  const encoding = (res.headers.get("content-encoding") ?? "").toLowerCase();
  const format = isGzip ? "gzip" : encoding.includes("deflate") ? "deflate" : null;
  if (!format) return new TextDecoder().decode(buf);

  try {
    const stream = new Response(buf).body!.pipeThrough(new DecompressionStream(format));
    return await new Response(stream).text();
  } catch {
    // deflate can be raw (no zlib header) — retry once before giving up.
    if (format === "deflate") {
      try {
        const stream = new Response(buf).body!.pipeThrough(new DecompressionStream("deflate-raw"));
        return await new Response(stream).text();
      } catch {
        /* fall through */
      }
    }
    return "";
  }
}

/** Coerce a date string to ISO 8601, rejecting anything that isn't a plausible news publish date (parse failure, epoch, far future). */
function toIso(raw: string | undefined): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const t = new Date(s).getTime();
  if (isNaN(t)) return undefined;
  if (t < Date.parse("2000-01-01") || t > Date.now() + 2 * 86_400_000) return undefined;
  return new Date(t).toISOString();
}

// <meta> keys news sites use for the publish date, most reliable first.
const META_DATE_KEYS = [
  "article:published_time",
  "article:published",
  "og:published_time",
  "datePublished",
  "parsely-pub-date",
  "sailthru.date",
  "dc.date.issued",
  "dc.date",
  "publishdate",
  "publish-date",
  "pubdate",
];

/**
 * Best-effort publish date from the article HTML, for when the RSS feed or
 * search result carried none (common for `type: site` sources — SearXNG rarely
 * reports a date). Checks <meta> tags, JSON-LD datePublished, <time datetime>,
 * then a visible "Published: 27 Nov 2025" line as a last resort.
 */
function extractPublishedDate(html: string): string | undefined {
  const head = html.slice(0, 200_000);

  for (const key of META_DATE_KEYS) {
    const tag = head.match(
      new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key.replace(/\./g, "\\.")}["'][^>]*>`, "i"),
    )?.[0];
    const iso = toIso(tag?.match(/content=["']([^"']+)["']/i)?.[1]);
    if (iso) return iso;
  }

  for (const m of head.matchAll(/"datePublished"\s*:\s*"([^"]+)"/gi)) {
    const iso = toIso(m[1]);
    if (iso) return iso;
  }

  for (const m of head.matchAll(/<time[^>]+datetime=["']([^"']+)["']/gi)) {
    const iso = toIso(m[1]);
    if (iso) return iso;
  }

  const visible = html.match(
    /published\s*:?\s*([0-9]{1,2}\s+[A-Za-z]{3,9}\.?\s+[0-9]{4})(?:\s+at\s+[0-9]{1,2}[:.][0-9]{2})?/i,
  );
  return toIso(visible?.[1]);
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; RiverWatchBot/1.0; research aggregator; +https://cloudflare-searxng.songpont.workers.dev)";

/** Fetches a URL and returns its decoded HTML, or null on any failure (non-2xx, non-HTML, timeout, unreadable body). */
export async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": USER_AGENT } });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") ?? "").includes("html")) return null;
    return (await readBody(res)) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface ArticleResult {
  text: string;
  publishedAt?: string;
}

/** Fetches the article page and returns its lead text plus a publish date when the markup carries one, or null on any failure (blocked, non-HTML, too short to be real content, etc). */
export async function fetchArticle(url: string): Promise<ArticleResult | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const text = extractArticleText(html);
  if (text.length < MIN_LENGTH) return null;
  // Recovery failed (novel obfuscation, partial reversal, etc) — better to
  // fall back to the RSS/search snippet than store mirror text.
  if (looksReversed(text)) return null;
  return { text: text.slice(0, MAX_LENGTH), publishedAt: extractPublishedDate(html) };
}
