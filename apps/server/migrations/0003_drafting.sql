-- Phase 3: per-message sorting record (for the CRM agreement check) and draft review.

CREATE TABLE message_labels (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  label_key TEXT NOT NULL,
  label_by TEXT NOT NULL,
  confidence REAL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (mailbox_id, gmail_message_id)
);

-- The owner's rating of an AI draft during the shadow run (Phase 3 exit check):
-- 2 = send as is, 1 = small edits, 0 = rewrite.
ALTER TABLE drafts ADD COLUMN rating INTEGER CHECK (rating IN (0, 1, 2));
ALTER TABLE drafts ADD COLUMN rated_at TEXT;
ALTER TABLE drafts ADD COLUMN for_message_id TEXT;

ALTER TABLE voice_profiles ADD COLUMN mailbox_address TEXT;
