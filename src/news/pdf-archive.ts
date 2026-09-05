import type { Env } from "../env";

/**
 * Durable archive for PDFs harvested by usePdfExtract sources, in R2. This is
 * generic (any `type: page` source can use it), unlike the site-specific
 * quirk-handling in sources/pdf-reports.ts — the point of an archive doesn't
 * change per site, only which links get fed into it.
 *
 * Government sites reorganize or delete old documents without notice, and the
 * source .go.th listing is otherwise the only copy of each report; Tavily's
 * /extract also always re-fetches from the live URL, so archiving here does
 * not make extraction itself more reliable — it protects against the link
 * going away entirely, and gives us a durable copy to point a different
 * extraction method at later if we ever need one.
 */

const USER_AGENT =
  "Mozilla/5.0 (compatible; RiverWatchBot/1.0; research aggregator; +https://cloudflare-searxng.songpont.workers.dev)";

async function hashUrl(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Downloads and stores the file at `url` under a content-addressed key, skipping the fetch entirely if already archived. Never throws — archival failure shouldn't block the rest of collection. */
export async function archiveDocument(env: Env, url: string): Promise<void> {
  if (!env.PDF_ARCHIVE) return;
  try {
    const key = await hashUrl(url);
    const existing = await env.PDF_ARCHIVE.head(key);
    if (existing) return;

    const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (!res.ok) return;
    const body = await res.arrayBuffer();
    await env.PDF_ARCHIVE.put(key, body, {
      httpMetadata: { contentType: res.headers.get("content-type") ?? "application/octet-stream" },
      customMetadata: { sourceUrl: url, archivedAt: new Date().toISOString() },
    });
  } catch (err) {
    console.error(`pdf archive failed for ${url}`, err);
  }
}
