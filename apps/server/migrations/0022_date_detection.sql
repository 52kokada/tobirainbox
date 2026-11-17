-- Calendar plan step 9: date detection at ingest. Additive only.
-- suggestions.message_at: the sent time of the mail a suggestion came from, so a later message on the
--   same thread supersedes earlier ones even when an older message is detected late (next-day retry).
-- date_detection_deferred: messages whose model call was skipped because the date sub-cap (§5, D42) was
--   reached. Ids only, no body: the worker fetches the message again from Gmail the next UTC day.
ALTER TABLE suggestions ADD COLUMN message_at TEXT;

CREATE TABLE date_detection_deferred (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  gmail_message_id TEXT NOT NULL,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  deferred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (mailbox_id, gmail_message_id)
);
CREATE INDEX date_detection_deferred_business ON date_detection_deferred (business_id, deferred_at);
