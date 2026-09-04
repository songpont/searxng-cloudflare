import type { Env } from "./env";
import { SearxngContainer, ConfigStore, getConfig, patchConfig, runSearch, type SearchConfig } from "./search";
import { runDailyCollection } from "./news/collector";
import { runWeeklySummary } from "./news/summarizer";

export { SearxngContainer, ConfigStore };

const CHAT_SYSTEM_PROMPT = `You are a configuration assistant for a self-hosted SearXNG metasearch instance.
You can change these settings only:
- language: an ISO 639-1 code (e.g. "en", "th") or "auto"
- safeSearch: 0 (off), 1 (moderate), 2 (strict)
- categories: subset of ["general","images","videos","news","map","music","it","science","files","social media"]
- engines: array of searxng engine names (e.g. "google","bing","duckduckgo","wikipedia","github"), or [] to use defaults

Reply ONLY with a single JSON object, no prose outside it, shaped exactly as:
{"reply": "<short explanation, same language the user wrote in>", "config": { <only the fields you are changing> }}`;

async function runChat(env: Env, message: string): Promise<Response> {
  if (!env.DEEPSEEK_API_KEY) {
    return Response.json({ error: "DEEPSEEK_API_KEY is not configured" }, { status: 500 });
  }

  const current = await getConfig(env);
  const deepseekRes = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "user", content: `Current config: ${JSON.stringify(current)}\n\nUser request: ${message}` },
      ],
    }),
  });

  if (!deepseekRes.ok) {
    const detail = await deepseekRes.text();
    return Response.json({ error: "deepseek request failed", detail }, { status: 502 });
  }

  const data = (await deepseekRes.json()) as {
    choices: { message: { content: string } }[];
  };

  let parsed: { reply: string; config?: Partial<SearchConfig> };
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch {
    return Response.json({ error: "could not parse model response" }, { status: 502 });
  }

  const nextConfig = parsed.config ? await patchConfig(env, parsed.config) : current;
  return Response.json({ reply: parsed.reply, config: nextConfig });
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/search") {
      if (!isAuthorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const q = url.searchParams.get("q");
      if (!q) return Response.json({ error: "missing q" }, { status: 400 });
      return runSearch(env, q);
    }

    if (url.pathname === "/api/config") {
      if (!isAuthorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (request.method === "POST") {
        const patch = (await request.json()) as Partial<SearchConfig>;
        return Response.json(await patchConfig(env, patch));
      }
      return Response.json(await getConfig(env));
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!isAuthorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const { message } = (await request.json()) as { message: string };
      return runChat(env, message);
    }

    if (url.pathname === "/api/news") {
      const perPage = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 100);
      const page = Math.max(Number(url.searchParams.get("page") ?? 1), 1);
      const offset = (page - 1) * perPage;
      const [list, totalRow] = await Promise.all([
        env.river_watch_db
          .prepare(`SELECT * FROM articles ORDER BY collected_at DESC LIMIT ? OFFSET ?`)
          .bind(perPage, offset)
          .all(),
        env.river_watch_db.prepare(`SELECT COUNT(*) AS n FROM articles`).first<{ n: number }>(),
      ]);
      return Response.json({ articles: list.results, total: totalRow?.n ?? 0, page, perPage });
    }

    if (url.pathname === "/api/stats") {
      const [perDay, byTrust, bySource] = await Promise.all([
        env.river_watch_db
          .prepare(
            `SELECT substr(collected_at, 1, 10) AS day, trust, COUNT(*) AS n
             FROM articles
             WHERE collected_at >= date('now', '-90 days')
             GROUP BY day, trust
             ORDER BY day`,
          )
          .all(),
        env.river_watch_db.prepare(`SELECT trust, COUNT(*) AS n FROM articles GROUP BY trust ORDER BY n DESC`).all(),
        env.river_watch_db
          .prepare(
            `SELECT source_id, source_name, trust, COUNT(*) AS n
             FROM articles GROUP BY source_id ORDER BY n DESC`,
          )
          .all(),
      ]);
      return Response.json({ perDay: perDay.results, byTrust: byTrust.results, bySource: bySource.results });
    }

    if (url.pathname === "/api/summary/latest") {
      const { results } = await env.river_watch_db
        .prepare(`SELECT * FROM weekly_summaries ORDER BY created_at DESC LIMIT 1`)
        .all();
      return Response.json({ summary: results[0] ?? null });
    }

    if (url.pathname === "/api/summaries") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 26), 100);
      const { results } = await env.river_watch_db
        .prepare(`SELECT * FROM weekly_summaries ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all();
      return Response.json({ summaries: results });
    }

    if (url.pathname === "/api/collect" && request.method === "POST") {
      if (!isAuthorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const result = await runDailyCollection(env);
      return Response.json(result);
    }

    if (url.pathname === "/api/summarize" && request.method === "POST") {
      if (!isAuthorized(request, env)) return Response.json({ error: "unauthorized" }, { status: 401 });
      const result = await runWeeklySummary(env);
      return Response.json(result);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "0 20 * * *") {
      ctx.waitUntil(runDailyCollection(env));
    } else if (event.cron === "0 20 * * 1") {
      ctx.waitUntil(runWeeklySummary(env));
    }
  },
};
