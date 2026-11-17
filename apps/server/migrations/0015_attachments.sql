-- Files the person attaches to a reply (sent with it, then kept for the record).
CREATE TABLE thread_attachments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX thread_attachments_open ON thread_attachments (thread_id) WHERE sent_at IS NULL;
