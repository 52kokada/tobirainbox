-- Phase 5: browser push notifications (phones/desktops), in place of LINE until LINE is set up.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error TEXT
);

-- One notification per (thread, message). Existing mail is marked as already notified.
CREATE TABLE notifications (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, message_id)
);
INSERT OR IGNORE INTO notifications (thread_id, message_id, business_id)
  SELECT id, last_message_id, business_id FROM threads WHERE last_message_id IS NOT NULL;
