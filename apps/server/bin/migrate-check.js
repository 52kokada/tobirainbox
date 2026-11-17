#!/usr/bin/env node
// Apply pending migrations to a COPY of a database and print row counts before and after.
// Read-only on the source: it is opened readonly and copied with SQLite's online backup.
// Starts no server and no worker; imports only the migration runner.
//   node bin/migrate-check.js <path/to/tobira-inbox.db> [copyPath]
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/db.js';

const [src, dest = join(tmpdir(), `tobira-inbox-migrate-check-${Date.now()}.db`)] = process.argv.slice(2);
if (!src) { console.error('usage: node bin/migrate-check.js <db> [copyPath]'); process.exit(2); }

const counts = (db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));

const source = new Database(src, { readonly: true, fileMustExist: true });
await source.backup(dest);
source.close();

const copy = new Database(dest);
copy.pragma('foreign_keys = ON');
const before = counts(copy);
const names = () => (copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  ? copy.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r) => r.name) : []);
const had = new Set(names());
migrate(copy);
const after = counts(copy);
const changed = Object.keys(before).filter((t) => t !== 'schema_migrations' && t in after && before[t] !== after[t]);
const applied = copy.prepare('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 3').all().map((r) => r.name);
const appliedNow = names().filter((n) => !had.has(n)); // every migration this run applied, oldest first
const fk = copy.pragma('foreign_key_check');
copy.close();
console.log(JSON.stringify({ copy: dest, latest: applied, appliedNow, before, after, changedCounts: changed, foreignKeyProblems: fk.length }, null, 2));
process.exit(changed.length || fk.length ? 1 : 0);
