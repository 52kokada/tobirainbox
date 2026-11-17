// apps/server/src/db.js — open SQLite and apply migrations/*.sql in order.
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  migrate(db);
  return db;
}

/**
 * The web service and the worker start together after a deploy. Each migration is
 * applied inside an IMMEDIATE transaction that re-checks schema_migrations after
 * taking the write lock, so only one process applies it and the other skips it.
 */
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    // A table rebuild (SQLite's 12-step recipe) needs foreign keys off around the transaction; every reference
    // is checked before commit, so a broken rebuild rolls back instead of landing.
    const fkOff = sql.includes('-- @foreign-keys-off');
    const wasOn = db.pragma('foreign_keys', { simple: true });
    if (fkOff && wasOn) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(f)) return;
        db.exec(sql);
        if (fkOff && db.pragma('foreign_key_check').length) throw new Error(`${f}: foreign key check failed`);
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      }).immediate();
    } finally {
      if (fkOff && wasOn) db.pragma('foreign_keys = ON');
    }
  }
}
