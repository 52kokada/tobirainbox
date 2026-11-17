-- Phase 2: Gmail connect + ingest + sorting (shadow).

-- One-time OAuth `state` values (CSRF protection for the connect flow).
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  login_hint TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Every Gmail message id we have looked at, so a poll never re-sorts (and never
-- pays the model twice for) the same message. No content stored.
CREATE TABLE seen_messages (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  gmail_message_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sorted','excluded','own','skipped')),
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (mailbox_id, gmail_message_id)
);

ALTER TABLE mailboxes ADD COLUMN write_labels INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mailboxes ADD COLUMN last_error TEXT;
ALTER TABLE mailboxes ADD COLUMN connected_at TEXT;
