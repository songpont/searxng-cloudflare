import type { Env } from "../env";

interface ArticleRow {
  title: string;
  snippet: string | null;
  source_name: string;
  trust: string;
  url: string;
  published_at: string | null;
}

const SUMMARY_SYSTEM_PROMPT =
  "คุณคือนักวิเคราะห์สถานการณ์สิ่งแวดล้อม สรุปข่าวอย่างเป็นกลาง ให้น้ำหนักแหล่งข่าวทางการก่อนแหล่งข่าวทั่วไป และอ้างอิงแหล่งที่มาเสมอ " +
  "ข่าวที่ tag ว่า [web] มาจากการค้นเว็บเปิดแบบอัตโนมัติ ยังไม่ผ่านการตรวจสอบแหล่งที่มา ต้องระบุกำกับชัดเจนว่า 'ยังไม่ยืนยัน' ทุกครั้งที่อ้างถึง และห้ามใช้เป็นข้อสรุปหลักโดยไม่มีแหล่ง official หรือ news สนับสนุน. " +
  "ทุกครั้งที่อ้างอิงข่าวในเนื้อหา ต้องใส่เป็นลิงก์ markdown ที่คลิกได้ทันที ไม่ใช่ตัวเลขเปล่าๆ";

export async function runWeeklySummary(env: Env): Promise<{ summary: string; count: number }> {
  const weekEnd = new Date();
  const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekStartIso = weekStart.toISOString();
  const weekEndIso = weekEnd.toISOString();

  // "This week's situation" means the article's own date falls in the window,
  // not merely that we happened to scrape it this week (a search can resurface
  // an old article at any time). published_at is unreliable for many sources
  // (see collector.ts), so articles with no known date fall back to being
  // included by collected_at instead of being silently dropped.
  const { results } = await env.river_watch_db
    .prepare(
      `SELECT title, snippet, source_name, trust, url, published_at FROM articles
       WHERE (published_at IS NOT NULL AND published_at >= ? AND published_at <= ?)
          OR (published_at IS NULL AND collected_at >= ? AND collected_at <= ?)
       ORDER BY CASE trust WHEN 'official' THEN 0 WHEN 'news' THEN 1 WHEN 'social' THEN 2 ELSE 3 END, collected_at DESC
       LIMIT 60`,
    )
    .bind(weekStartIso, weekEndIso, weekStartIso, weekEndIso)
    .all<ArticleRow>();

  if (results.length === 0) {
    const summary = "ไม่มีข่าวของช่วงสัปดาห์นี้ที่เก็บได้";
    await saveSummary(env, weekStart, weekEnd, summary, 0);
    return { summary, count: 0 };
  }

  const articlesText = results
    .map((a, i) => {
      const dateLabel = a.published_at ? new Date(a.published_at).toISOString().slice(0, 10) : "ไม่ทราบวันที่ตีพิมพ์";
      return `${i + 1}. [${a.trust}] (${dateLabel}) ${a.title} — ${a.source_name}${a.snippet ? `: ${a.snippet}` : ""} URL: ${a.url}`;
    })
    .join("\n");

  const prompt = `นี่คือข่าวของสัปดาห์ ${weekStartIso.slice(0, 10)} ถึง ${weekEndIso.slice(0, 10)} เกี่ยวกับสารพิษปนเปื้อนแม่น้ำกก แม่น้ำสาย แม่น้ำโขง และแม่น้ำสาละวิน:

${articlesText}

กรุณาสรุปสถานการณ์ของสัปดาห์นี้เป็นภาษาไทย โดย:
- ให้น้ำหนักข่าวจากแหล่งทางการ (official) เป็นหลัก ใช้ข่าวจากสื่อ (news) เสริมบริบท
- ข่าว tag [web] ใช้เป็นข้อมูลเสริม/เบาะแสเท่านั้น ต้องระบุว่า "ยังไม่ยืนยัน" ทุกครั้งที่กล่าวถึง
- สรุปว่าใครกำลังดำเนินการอะไรอยู่บ้าง (หน่วยงาน, มาตรการ, ความคืบหน้า)
- ถ้ามีข้อมูลขัดแย้งกันระหว่างแหล่ง ให้ระบุไว้
- ทุกครั้งที่อ้างอิงข่าวในเนื้อหา ให้ใส่เป็นลิงก์ markdown ที่คลิกได้ทันทีโดยใช้ URL จริงของข่าวนั้น รูปแบบ [หมายเลขข่าว](URL) เช่น อ้างข่าวลำดับที่ 3 ให้เขียนว่า "...ข้อความ... ([3](https://example.com/article))" ถ้าอ้างหลายข่าวพร้อมกันให้คั่นด้วยจุลภาค เช่น "([3](url3), [7](url7))" ห้ามอ้างอิงด้วยเลขเปล่าๆ ที่ไม่มีลิงก์เด็ดขาด
- ปิดท้ายด้วยรายการอ้างอิงแหล่งข่าวที่ใช้ทั้งหมด (ชื่อแหล่ง + ลิงก์)`;

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`deepseek summary request failed: ${await res.text()}`);
  }

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const summary = data.choices[0].message.content;

  await saveSummary(env, weekStart, weekEnd, summary, results.length);
  return { summary, count: results.length };
}

async function saveSummary(env: Env, weekStart: Date, weekEnd: Date, summary: string, count: number): Promise<void> {
  await env.river_watch_db
    .prepare(
      `INSERT INTO weekly_summaries (week_start, week_end, summary, article_count, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(weekStart.toISOString(), weekEnd.toISOString(), summary, count, new Date().toISOString())
    .run();
}
