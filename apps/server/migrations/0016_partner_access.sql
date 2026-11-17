-- D8 partner role: limited access the shop agrees to. A partner sees only the mailboxes an owner
-- grants here, and may send only from those marked can_send. No row = no access (the default).
CREATE TABLE partner_mailboxes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  can_send INTEGER NOT NULL DEFAULT 0,
  granted_by TEXT,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, mailbox_id)
);
CREATE INDEX partner_mailboxes_business ON partner_mailboxes (business_id);
