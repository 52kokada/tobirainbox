-- Cold-outreach follow-ups from the optional external CRM backend. The worker reads CRM's
-- GET /api/internal/brain/outreach-followups for businesses with report_to_cockpit and stamps the latest
-- matching thread (counterpart address = contact_email). Stamps no longer in the feed are cleared; the lead
-- id stays so outcomes can still be recorded after the lead leaves both lists.
--   cockpit_lead_id               CRM's lead id (kept once matched)
--   outreach_bucket               'unanswered_positive' | 'gone_quiet' | NULL (not in the feed now)
--   outreach_days_quiet           days since our last message (gone_quiet), from CRM
--   outreach_positive_reply_at    when the lead replied positively (ordering of 営業の返信)
--   outreach_synced_at            when the stamp was last written
--   outreach_outcome(_at)         the last outcome recorded here (打ち合わせ確定 / 提案送付 / 受注 / 失注)
ALTER TABLE threads ADD COLUMN cockpit_lead_id TEXT;
ALTER TABLE threads ADD COLUMN outreach_bucket TEXT;
ALTER TABLE threads ADD COLUMN outreach_days_quiet INTEGER;
ALTER TABLE threads ADD COLUMN outreach_positive_reply_at TEXT;
ALTER TABLE threads ADD COLUMN outreach_synced_at TEXT;
ALTER TABLE threads ADD COLUMN outreach_outcome TEXT;
ALTER TABLE threads ADD COLUMN outreach_outcome_at TEXT;
CREATE INDEX threads_outreach ON threads (business_id, outreach_bucket);

-- Leads in the feed with no matching thread in Inbox (the mailbox they replied to may not be connected).
-- Replaced as a whole on every sync of the business.
CREATE TABLE outreach_leads (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  lead_id TEXT NOT NULL,
  company_name TEXT,
  contact_email TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('unanswered_positive','gone_quiet')),
  positive_reply_at TEXT,
  last_activity_at TEXT,
  days_quiet INTEGER,
  draft_subject TEXT,
  draft_body TEXT,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (business_id, lead_id)
);

-- Outcome events (打ち合わせ確定 / 提案送付 / 受注 / 失注) go through the same outbox. SQLite cannot change a
-- CHECK in place: rebuild the table keeping every id, so delivered eventIds (tobira-inbox:<id>) never repeat.
CREATE TABLE outbox_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sorted','sent','relabelled','outcome')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT
);
INSERT INTO outbox_events_new (id, business_id, type, payload_json, status, attempts, last_error, created_at, delivered_at)
  SELECT id, business_id, type, payload_json, status, attempts, last_error, created_at, delivered_at FROM outbox_events;
DROP TABLE outbox_events;
ALTER TABLE outbox_events_new RENAME TO outbox_events;
CREATE INDEX outbox_pending ON outbox_events (status, id);
