-- Things a person must know about: a send that failed for good, a disconnected mailbox, a draft the AI gave up on.
CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('send_failed','mailbox_error','draft_failed')),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE UNIQUE INDEX alerts_open_key ON alerts (business_id, kind, key) WHERE resolved_at IS NULL;
