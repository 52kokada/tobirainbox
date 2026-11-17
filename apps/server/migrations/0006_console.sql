-- Phase 4: console sign-in (Google) and sessions.

ALTER TABLE oauth_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'connect' CHECK (purpose IN ('connect','login'));
ALTER TABLE oauth_states ADD COLUMN return_to TEXT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- random, stored hashed? no: cookie carries id + HMAC; id itself is 32 random bytes
  user_id TEXT NOT NULL REFERENCES users(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN locale TEXT;
