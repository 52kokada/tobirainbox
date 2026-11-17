-- Phase 6: report sorted / sent / relabelled mail back to the optional external CRM backend (D31) so
-- outreach lead states and thread ledgers stay right when Tobira works from the console.

ALTER TABLE businesses ADD COLUMN report_to_cockpit INTEGER NOT NULL DEFAULT 0;
UPDATE businesses SET report_to_cockpit = 1 WHERE name = 'Example Studio';

CREATE TABLE outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sorted','sent','relabelled')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT
);
CREATE INDEX outbox_pending ON outbox_events (status, id);
