-- @foreign-keys-off
-- D8: a person (one Google email) can belong to several businesses, with a role in each: owner / staff / partner.
-- Each users row is that person's membership in one business. Rebuilt only to allow the 'partner' role
-- (SQLite's documented table rebuild; the migration runner checks every foreign key before committing).
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','staff','partner')),
  line_user_id TEXT,
  push_subscription TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT,
  locale TEXT,
  UNIQUE (business_id, email)
);
INSERT INTO users_new (id, business_id, email, name, role, line_user_id, push_subscription, created_at, last_login_at, locale)
  SELECT id, business_id, email, name, role, line_user_id, push_subscription, created_at, last_login_at, locale FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX users_email ON users (email COLLATE NOCASE);
