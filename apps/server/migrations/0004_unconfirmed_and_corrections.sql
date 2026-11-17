-- 要確認 instead of その他 for anything the system could not confirm,
-- and person corrections that the sorter learns from.

ALTER TABLE threads ADD COLUMN label_guess TEXT;

CREATE TABLE label_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  thread_id TEXT REFERENCES threads(id),
  from_label TEXT,
  to_label TEXT NOT NULL,
  from_domain TEXT,
  subject_redacted TEXT,
  excerpt_redacted TEXT,
  user_id TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX label_corrections_recent ON label_corrections (business_id, at);

UPDATE threads SET label_key = 'unconfirmed' WHERE label_by IN ('fallback', 'budget');
UPDATE message_labels SET label_key = 'unconfirmed' WHERE label_by IN ('fallback', 'budget');
