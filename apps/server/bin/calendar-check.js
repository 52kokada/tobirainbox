#!/usr/bin/env node
// Read-only calendar check (plan step 4 Verify): lists the next 7 days of one mailbox's primary calendar
// through calendarFor, so it exercises the same credential path the server uses. Starts no server or
// worker and imports no send, outbox, ingest or label module. Opens the DB read-only.
//   node bin/calendar-check.js <mailbox address> [--db path]
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { calendarFor } from '../src/calendar.js';
import { SaTokens, signerFromConfig } from '../src/sa-token.js';

const args = process.argv.slice(2);
const address = args.find((a) => !a.startsWith('--'))?.toLowerCase();
const dbFlag = args.indexOf('--db');
if (!address) { console.error('usage: node bin/calendar-check.js <mailbox address> [--db path]'); process.exit(2); }
const config = loadConfig();
const db = new Database(dbFlag >= 0 ? args[dbFlag + 1] : join(config.dataDir, 'tobira-inbox.db'), { readonly: true, fileMustExist: true });
const mbx = db.prepare('SELECT * FROM mailboxes WHERE lower(address) = ?').get(address);
if (!mbx) { console.error(`no mailbox ${address}`); process.exit(1); }
const signer = signerFromConfig({ db, config });
const cal = calendarFor(mbx, { db, config, saTokens: signer ? new SaTokens({ db, config, signer }) : null });
const now = new Date();
const { items } = await cal.listEvents('primary', { timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 7 * 86400_000).toISOString() });
console.log(JSON.stringify({ mailbox: address, signer: signer?.kind ?? null, count: items.length,
  events: items.map((e) => ({ start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date, summary: e.summary ?? '', visibility: e.visibility ?? 'default' })) }, null, 2));
db.close();
