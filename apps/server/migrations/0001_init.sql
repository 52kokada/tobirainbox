-- TobirAInbox initial schema (plan.md §3). Every business-owned row carries business_id.
-- Email bodies are NOT stored (D9); threads keep ids + a short-lived list cache.

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','paused')),
  locale TEXT NOT NULL DEFAULT 'ja',
  undo_seconds INTEGER NOT NULL DEFAULT 30 CHECK (undo_seconds BETWEEN 5 AND 30),
  plain_text INTEGER NOT NULL DEFAULT 0,
  shared_voice_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','staff')),
  line_user_id TEXT,
  push_subscription TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (business_id, email)
);

CREATE TABLE voice_profiles (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  full_name TEXT NOT NULL,
  style TEXT,
  signature TEXT,
  signature_html TEXT
);

CREATE TABLE mailboxes (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  address TEXT NOT NULL,
  display_name TEXT,
  provider TEXT NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail','outlook')),
  token_enc TEXT,
  history_id TEXT,
  voice_profile_id TEXT REFERENCES voice_profiles(id),
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','live','paused')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','error','disconnected')),
  last_polled_at TEXT,
  UNIQUE (business_id, address)
);

CREATE TABLE intake_rules (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  mailbox_id TEXT REFERENCES mailboxes(id),
  kind TEXT NOT NULL CHECK (kind IN ('exclude_sender','exclude_domain','exclude_gmail_label','include_only_gmail_label')),
  value TEXT NOT NULL
);

CREATE TABLE label_overrides (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  key TEXT NOT NULL,
  ja TEXT, en TEXT, hint TEXT,
  hidden INTEGER,
  auto_draft INTEGER,
  PRIMARY KEY (business_id, key)
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  gmail_thread_id TEXT NOT NULL,
  last_message_id TEXT,
  last_rfc_message_id TEXT,
  label_key TEXT,
  label_confidence REAL,
  label_by TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','drafted','waiting','sent','done','ignored')),
  assignee_user_id TEXT REFERENCES users(id),
  cache_from TEXT, cache_subject TEXT, cache_snippet TEXT,
  cache_expires_at TEXT,
  last_message_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (mailbox_id, gmail_thread_id)
);
CREATE INDEX threads_triage ON threads (business_id, status, last_message_at);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  version INTEGER NOT NULL,
  body_text TEXT NOT NULL,
  blanks_json TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL CHECK (created_by IN ('ai','user')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','queued','sent','discarded')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (thread_id, version)
);

CREATE TABLE playbook_rules (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  label_key TEXT,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','ai_proposed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposed','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','website','line_answer')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (business_id, key)
);

CREATE TABLE owner_questions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  question TEXT NOT NULL,
  line_message_id TEXT,
  answer TEXT,
  answered_at TEXT
);

CREATE TABLE examples (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  mailbox_id TEXT REFERENCES mailboxes(id),
  label_key TEXT,
  incoming_redacted TEXT NOT NULL,
  reply_redacted TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sends (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  body_text TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  undo_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','cancelled','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  gmail_message_id TEXT,
  error TEXT,
  finished_at TEXT
);
CREATE INDEX sends_due ON sends (status, undo_until);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
