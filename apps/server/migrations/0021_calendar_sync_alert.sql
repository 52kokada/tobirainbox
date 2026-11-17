-- @foreign-keys-off
-- Calendar plan step 6: alerts gain the kind 'calendar_sync' (a calendar failed 3 passes in a row).
-- Rebuild only to widen the CHECK; rows are copied unchanged.
CREATE TABLE alerts_new (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('send_failed','mailbox_error','draft_failed','calendar_sync')),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
INSERT INTO alerts_new (id, business_id, kind, key, title, body, url, created_at, resolved_at)
  SELECT id, business_id, kind, key, title, body, url, created_at, resolved_at FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;
CREATE UNIQUE INDEX alerts_open_key ON alerts (business_id, kind, key) WHERE resolved_at IS NULL;
