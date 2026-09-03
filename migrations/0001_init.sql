CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  snippet TEXT,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  trust TEXT NOT NULL,
  keyword TEXT,
  published_at TEXT,
  collected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_collected_at ON articles(collected_at);

CREATE TABLE IF NOT EXISTS weekly_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  summary TEXT NOT NULL,
  article_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
