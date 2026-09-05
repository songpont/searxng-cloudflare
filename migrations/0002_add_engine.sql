-- Which fetch mechanism actually produced the row: 'rss' (feed parse), 'page'
-- (direct HTML link harvest, no search engine), 'tavily' (Tavily Search API —
-- both type:site collection and the AI-followup round), or 'searxng' (reserved
-- for a future source type; nothing currently inserts this).
ALTER TABLE articles ADD COLUMN engine TEXT;
CREATE INDEX IF NOT EXISTS idx_articles_engine ON articles(engine);
