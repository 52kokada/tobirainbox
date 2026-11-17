-- @foreign-keys-off
-- Calendar tab (plan step 3, §4). Additive only: new columns and tables, all dark behind
-- businesses.calendar_mode = 'off'. Rolling back the code leaves them unused; no down-migration.
-- All times are UTC ISO strings. oauth_states is rebuilt only to let purpose take 'calendar'.

-- Per business.
--   calendar_mode                   off | shadow (writes only to shadow_calendar_id, UI admin-only) | on (D45)
--   timezone                        IANA zone the business works in (D35); owners may change it
--   calendar_access                 delegated (Tobira, service account) | per_mailbox (client OAuth) (D24)
--   hold_calendar_id                the shared 調整中 calendar, once created (step 5)
--   hold_calendar_owner_mailbox_id  the one mailbox that owns that calendar and makes every hold write (D43, D52)
--   shadow_calendar_id              test calendar used while calendar_mode = 'shadow'
--   hold_silence_days               an unconfirmed hold goes after this many days of silence (D46)
--   free_slot_hours                 JSON {"days":[0-6, 0 = Sunday],"from":"HH:MM","to":"HH:MM"} in the business
--                                   timezone: the hours free-slot drafts may offer (D49); owners may change it
ALTER TABLE businesses ADD COLUMN calendar_mode TEXT NOT NULL DEFAULT 'off' CHECK (calendar_mode IN ('off','shadow','on'));
ALTER TABLE businesses ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo';
ALTER TABLE businesses ADD COLUMN calendar_access TEXT NOT NULL DEFAULT 'per_mailbox' CHECK (calendar_access IN ('delegated','per_mailbox'));
ALTER TABLE businesses ADD COLUMN hold_calendar_id TEXT;
ALTER TABLE businesses ADD COLUMN hold_calendar_owner_mailbox_id TEXT REFERENCES mailboxes(id);
ALTER TABLE businesses ADD COLUMN shadow_calendar_id TEXT;
ALTER TABLE businesses ADD COLUMN hold_silence_days INTEGER NOT NULL DEFAULT 7 CHECK (hold_silence_days BETWEEN 1 AND 90);
ALTER TABLE businesses ADD COLUMN free_slot_hours TEXT NOT NULL DEFAULT '{"days":[1,2,3,4,5],"from":"10:00","to":"18:00"}';

-- Per mailbox: the calendar token is separate from the Gmail token, so a calendar failure never breaks mail.
ALTER TABLE mailboxes ADD COLUMN calendar_token_enc TEXT;
ALTER TABLE mailboxes ADD COLUMN calendar_status TEXT NOT NULL DEFAULT 'none' CHECK (calendar_status IN ('none','ok','error'));
ALTER TABLE mailboxes ADD COLUMN calendar_error TEXT;
ALTER TABLE mailboxes ADD COLUMN calendar_synced_at TEXT;

-- oauth_states: purpose gains 'calendar', plus the mailbox a calendar consent is for.
CREATE TABLE oauth_states_new (
  state TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  login_hint TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  purpose TEXT NOT NULL DEFAULT 'connect' CHECK (purpose IN ('connect','login','calendar')),
  return_to TEXT,
  oauth_client TEXT NOT NULL DEFAULT 'internal',
  mailbox_id TEXT REFERENCES mailboxes(id)
);
INSERT INTO oauth_states_new (state, business_id, login_hint, expires_at, used_at, purpose, return_to, oauth_client)
  SELECT state, business_id, login_hint, expires_at, used_at, purpose, return_to, oauth_client FROM oauth_states;
DROP TABLE oauth_states;
ALTER TABLE oauth_states_new RENAME TO oauth_states;

-- Sync position per calendar we read (mailbox_id NULL = the business's 調整中 calendar).
CREATE TABLE calendar_sync (
  id INTEGER PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  mailbox_id TEXT REFERENCES mailboxes(id),
  google_calendar_id TEXT NOT NULL,
  sync_token TEXT,
  window_from TEXT,
  window_to TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (business_id, google_calendar_id)
);

-- Read-through cache of Google events. Full fields; private ones are stripped per viewer at read time.
CREATE TABLE calendar_events (
  id INTEGER PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  mailbox_id TEXT REFERENCES mailboxes(id),
  google_calendar_id TEXT NOT NULL,
  google_event_id TEXT NOT NULL,
  etag TEXT,
  start_utc TEXT,
  end_utc TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  location TEXT,
  meet_url TEXT,
  visibility TEXT,
  ours_tag TEXT,
  status TEXT,
  updated_at TEXT,
  UNIQUE (business_id, google_calendar_id, google_event_id)
);
CREATE INDEX calendar_events_range ON calendar_events (business_id, start_utc);

-- Dates detected in mail (AI) or calendar invites. No body text: a redacted quote of at most 120 chars.
-- thread_id is NULL while the Gmail thread has no thread row; it links by (mailbox_id, gmail_thread_id) until then.
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  thread_id TEXT REFERENCES threads(id),
  gmail_thread_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('ours','theirs')),
  source TEXT NOT NULL CHECK (source IN ('ai','invite')),
  start_utc TEXT NOT NULL,
  end_utc TEXT,
  stated_tz TEXT,
  business_tz TEXT,
  quote_redacted TEXT CHECK (quote_redacted IS NULL OR length(quote_redacted) <= 120),
  counterpart_label TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('offer','confirm','change','cancel')),
  state TEXT NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested','held','dismissed','superseded')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX suggestions_open ON suggestions (business_id, state, start_utc);
CREATE INDEX suggestions_gmail_thread ON suggestions (mailbox_id, gmail_thread_id);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  thread_id TEXT REFERENCES threads(id),
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  title TEXT,
  place TEXT,
  link_url TEXT,
  link_source TEXT NOT NULL DEFAULT 'none' CHECK (link_source IN ('mail','meet','none')),
  conference_status TEXT NOT NULL DEFAULT 'none' CHECK (conference_status IN ('none','pending','ready','failed')),
  google_calendar_id TEXT,
  google_event_id TEXT,
  etag TEXT,
  state TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('confirmed','cancelled','undone')),
  confirmed_by_user_id TEXT REFERENCES users(id),
  confirmed_by_label TEXT,
  confirmed_via TEXT NOT NULL CHECK (confirmed_via IN ('console','manager','invite')),
  idem_key TEXT NOT NULL UNIQUE,
  invite_attendees_json TEXT,
  invite_state TEXT NOT NULL DEFAULT 'none' CHECK (invite_state IN ('none','queued','sent','cancelled')),
  invite_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX meetings_range ON meetings (business_id, start_utc);

CREATE TABLE holds (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id),
  meeting_id TEXT REFERENCES meetings(id),
  google_calendar_id TEXT,
  google_event_id TEXT,
  etag TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','confirmed_away','expired','flagged','removed')),
  expires_at TEXT,
  flagged_reason TEXT
);
CREATE INDEX holds_state ON holds (business_id, state, expires_at);

-- One row per Google write: idempotency, retries and the source for sync health.
CREATE TABLE calendar_writes (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL,
  target_id TEXT,
  idem_key TEXT NOT NULL UNIQUE,
  google_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX calendar_writes_status ON calendar_writes (business_id, status);

-- Undo links handed to Tobira Manager (step 19). Only the hash is stored.
CREATE TABLE manager_undo_tokens (
  token_hash TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Detection results, kept only in shadow mode or for eval sampling (§5). No body text.
CREATE TABLE date_detections (
  id INTEGER PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  gmail_message_id TEXT NOT NULL,
  prefilter_hit INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX date_detections_msg ON date_detections (business_id, gmail_message_id);
