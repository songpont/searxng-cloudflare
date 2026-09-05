-- Marks articles from sources that publish on a fixed periodic schedule
-- (e.g. a monthly water-quality report) rather than as daily news. Their own
-- published_at is the underlying data's sampling period, which is routinely
-- older than the weekly summary window by the time we discover it — that's
-- expected, not staleness, so the summarizer includes them by collected_at
-- (when we found them) instead of excluding them by published_at.
ALTER TABLE articles ADD COLUMN periodic INTEGER NOT NULL DEFAULT 0;
