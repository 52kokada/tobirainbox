-- Second-release items from the grill-me (D8, D20/D25, D21, D22/D4, D23).

-- D8: read the business's website; what it finds waits as proposals until a person accepts.
ALTER TABLE businesses ADD COLUMN website_url TEXT;
ALTER TABLE businesses ADD COLUMN rules_proposed_at TEXT;
CREATE TABLE website_reads (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  pages INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX website_reads_recent ON website_reads (business_id, started_at);
CREATE TABLE fact_proposals (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX fact_proposals_open ON fact_proposals (business_id, status);

-- D22 / D4: every sent reply (and past sent mail on request) becomes a redacted example.
ALTER TABLE examples ADD COLUMN source TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE examples ADD COLUMN gmail_message_id TEXT;
CREATE UNIQUE INDEX examples_by_message ON examples (business_id, gmail_message_id) WHERE gmail_message_id IS NOT NULL;

-- D23: ask the owner to fill a 【要確認】 (push + console for now; LINE later).
ALTER TABLE owner_questions ADD COLUMN thread_id TEXT;
ALTER TABLE owner_questions ADD COLUMN blank TEXT;
ALTER TABLE owner_questions ADD COLUMN asked_by TEXT;
ALTER TABLE owner_questions ADD COLUMN answered_by TEXT;
ALTER TABLE owner_questions ADD COLUMN fact_key TEXT;
ALTER TABLE owner_questions ADD COLUMN created_at TEXT;

-- D20 / D25: invite-only self-serve sign-up while Google's review runs.
CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  used_at TEXT,
  used_by_email TEXT,
  business_id TEXT
);
