export interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .trim();
}

function extractTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeEntities(match[1]) : undefined;
}

export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];

  for (const block of xml.match(/<item[\s\S]*?<\/item>/gi) ?? []) {
    const title = extractTag(block, "title") ?? "";
    const link = extractTag(block, "link") ?? "";
    const description = extractTag(block, "description") ?? "";
    const pubDate = extractTag(block, "pubDate");
    if (title && link) items.push({ title, link, description, pubDate });
  }

  for (const block of xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? []) {
    const title = extractTag(block, "title") ?? "";
    const hrefMatch = block.match(/<link[^>]*href="([^"]+)"/i);
    const link = hrefMatch ? hrefMatch[1] : "";
    const description = extractTag(block, "summary") ?? extractTag(block, "content") ?? "";
    const pubDate = extractTag(block, "updated") ?? extractTag(block, "published");
    if (title && link) items.push({ title, link, description, pubDate });
  }

  return items;
}
