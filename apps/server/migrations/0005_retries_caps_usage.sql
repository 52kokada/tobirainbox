-- Retry failed drafts until clean; daily cap is a per-company
-- setting (UI later); robust per-company spend tracking.

ALTER TABLE businesses ADD COLUMN ai_daily_cap_usd REAL; -- NULL = server default (AI_DAILY_CAP_USD)

-- One row per (thread, message) we owe a draft for, until it succeeds.
CREATE TABLE draft_attempts (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','drafted','gave_up')),
  last_error TEXT,
  last_at TEXT,
  PRIMARY KEY (thread_id, message_id)
);
CREATE INDEX draft_attempts_pending ON draft_attempts (status, last_at);

-- Spend tracking: every call carries where it came from and its full token breakdown.
ALTER TABLE ai_usage ADD COLUMN mailbox_id TEXT;
ALTER TABLE ai_usage ADD COLUMN thread_id TEXT;
ALTER TABLE ai_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN request_id TEXT;      -- Claude API message id, for reconciling with the Console
ALTER TABLE ai_usage ADD COLUMN price_version TEXT;   -- which price table computed cost_usd
ALTER TABLE ai_usage ADD COLUMN outcome TEXT;         -- ok / error / refused
CREATE INDEX ai_usage_business_day ON ai_usage (business_id, at);

-- Daily roll-up per company (kept for invoices/dashboards even if raw rows are pruned later).
CREATE VIEW ai_usage_daily AS
  SELECT business_id, substr(at, 1, 10) AS day, operation, model,
         COUNT(*) AS calls, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
         SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
         ROUND(SUM(cost_usd), 6) AS cost_usd
  FROM ai_usage GROUP BY business_id, day, operation, model;

-- The first business runs uncapped-in-practice during development.
UPDATE businesses SET ai_daily_cap_usd = 20 WHERE name = 'Example Studio';
