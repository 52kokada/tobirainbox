-- Calendar deadlines (grill round 10, D54-D58). Additive only, dark behind businesses.calendar_mode = 'off'.
-- A general deadline item (D58): `type` names what is due. Which types are switched on lives in code
-- (src/deadlines.js DEADLINE_TYPES, only 'preview' today), so a new type needs no table rebuild.
--   due_date         date only, in the business timezone (YYYY-MM-DD)
--   source           mail_date (the client named it) | rule (3 calendar days after their reply, D55)
--   confirmed_at     NULL while it is the AI's suggestion on the thread card; set by the one-click confirm (D54)
--   state            open | done | dismissed
--   done_reason      manual | preview_sent (our mail carried the preview link) | published (publish hook) (D57)
--   client_label     display name or domain for the 締切 title; never an address
--   client_address   the client's address, lower case, only to match our sent mail and the publish hook (D57)
CREATE TABLE deadlines (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  type TEXT NOT NULL,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  thread_id TEXT REFERENCES threads(id),
  gmail_thread_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  client_label TEXT,
  client_address TEXT,
  due_date TEXT NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source TEXT NOT NULL CHECK (source IN ('mail_date','rule')),
  quote_redacted TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','dismissed')),
  done_reason TEXT CHECK (done_reason IS NULL OR done_reason IN ('manual','preview_sent','published')),
  confirmed_at TEXT,
  confirmed_by_user_id TEXT REFERENCES users(id),
  closed_at TEXT,
  closed_by_user_id TEXT REFERENCES users(id),
  message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (business_id, mailbox_id, gmail_thread_id, type)
);
CREATE INDEX deadlines_open ON deadlines (business_id, state, due_date);
CREATE INDEX deadlines_client ON deadlines (business_id, client_address);
