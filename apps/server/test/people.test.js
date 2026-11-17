// D8: one person (email) in several businesses, a role in each (owner / staff / partner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { migrate } from '../src/db.js';

const dir = new URL('../migrations/', import.meta.url);

test('migration 0014 keeps every user, session and audit row, and allows the partner role', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && x < '0014').sort()) {
    db.exec(readFileSync(new URL(f, dir), 'utf8')); db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, 'x');
  }
  db.prepare("INSERT INTO businesses (id, name, status) VALUES ('b1','T','active')").run();
  db.prepare("INSERT INTO users (id, business_id, email, role, last_login_at) VALUES ('u1','b1','a@x.jp','owner','2026-11-05')").run();
  db.prepare("INSERT INTO sessions (id, user_id, business_id, expires_at) VALUES ('s1','u1','b1','2099-01-01')").run();
  db.prepare("INSERT INTO audit_log (business_id, user_id, action) VALUES ('b1','u1','login')").run();
  migrate(db);
  assert.equal(db.prepare('SELECT last_login_at FROM users WHERE id = ?').get('u1').last_login_at, '2026-11-05');
  assert.equal(db.prepare('SELECT user_id FROM sessions').get().user_id, 'u1');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES ('u2','b1','p@x.jp','partner')").run();
  assert.throws(() => db.prepare("INSERT INTO users (id, business_id, email, role) VALUES ('u3','b1','q@x.jp','boss')").run());
});
