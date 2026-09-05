/**
 * Quirk-handling for `type: page` sources whose harvested links are downloadable
 * report documents (PDFs) rather than news pages — first written for a PCD
 * (Pollution Control Department) regional office's report listing, which:
 *   - gives every download/view link the same generic icon-only label, so the
 *     real title has to come from elsewhere (a URL query param, or the
 *     document's own text);
 *   - states each report's period in Thai-language phrasing with a
 *     Buddhist-era year, not a machine-readable date.
 *
 * Kept separate from collector.ts on purpose: when this specific site changes
 * its markup or date phrasing, the fix belongs here, not scattered through the
 * generic collection pipeline that every other source type also runs through.
 * If a second site needs this same handling later, it likely still wants a
 * dedicated file of its own — these heuristics are tuned to phrasing this one
 * office happens to use, not a general "parse any PDF listing" solution.
 */

const THAI_MONTHS: Record<string, number> = {
  มกราคม: 1,
  กุมภาพันธ์: 2,
  มีนาคม: 3,
  เมษายน: 4,
  พฤษภาคม: 5,
  มิถุนายน: 6,
  กรกฎาคม: 7,
  สิงหาคม: 8,
  กันยายน: 9,
  ตุลาคม: 10,
  พฤศจิกายน: 11,
  ธันวาคม: 12,
};

function buildThaiDate(day: number, month: number, yearBE: number): string | undefined {
  const yearCE = yearBE - 543;
  if (yearCE < 2000 || yearCE > new Date().getUTCFullYear() + 1 || day < 1 || day > 31) return undefined;
  return new Date(Date.UTC(yearCE, month - 1, day)).toISOString();
}

/**
 * PCD-style report PDFs state their period as e.g. "ระหว่างวันที่ 23 – 26
 * มิถุนายน 2569" (day range + month + bare Buddhist-era year — the more
 * common phrasing) or "(เดือนพฤษภาคม) ... ปีงบประมาณ พ.ศ.2569" (month name
 * with the year stated separately near "พ.ศ."). CE = BE − 543. A bare fiscal
 * year alone doesn't pin down a specific month reliably enough to report as
 * this document's date, so that combination is deliberately not matched.
 */
export function parseThaiReportDate(text: string): string | undefined {
  const monthNames = Object.keys(THAI_MONTHS).join("|");

  const withDay = text.match(new RegExp(`(\\d{1,2})\\s*(?:[-–]\\s*\\d{1,2}\\s*)?(${monthNames})\\s*(\\d{4})\\b`));
  if (withDay) {
    const iso = buildThaiDate(Number(withDay[1]), THAI_MONTHS[withDay[2]], Number(withDay[3]));
    if (iso) return iso;
  }

  const monthMatch = text.match(new RegExp(`เดือน(${monthNames})`));
  const yearMatch = text.match(/พ\.?ศ\.?\s*(\d{4})/);
  if (monthMatch && yearMatch) {
    const iso = buildThaiDate(1, THAI_MONTHS[monthMatch[1]], Number(yearMatch[1]));
    if (iso) return iso;
  }

  return undefined;
}

/** True for the generic button/icon label a listing page uses for its download/view links, rather than an actual document title. */
export function looksLikeGenericLabel(text: string): boolean {
  return text.trim().length < 10;
}

/**
 * Some document-listing CMSes (this PCD regional office included) put the
 * real document title in a query param (?n=...) on the download link itself,
 * since the link's visible text/icon carries none. Free and available before
 * any fetch — checked ahead of titleFromContent() so matchKeywords can judge
 * relevance (and skip spending an extract credit on an obviously off-topic
 * document) without downloading anything first.
 */
export function titleFromQueryParam(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("n")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Falls back to the document's own first line of text when neither the link
 * nor its query param gave us a title. PCD-style reports open with the title
 * immediately followed by "ตามที่ ..." boilerplate explaining the program —
 * cut there when present rather than keeping the whole run-on opening
 * sentence.
 */
export function titleFromContent(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.split(/\s+ตามที่\s+/)[0].slice(0, 200).trim();
}
