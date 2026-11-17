#!/usr/bin/env node
// Read-only sync check (plan step 6 Verify): prints one mailbox's events for this week (Mon-Sun in the
// business timezone) straight from Google, mapped the way calendar-sync stores them. Opens the DB
// read-only, writes nothing, starts no worker, imports no send, outbox, ingest or label module.
//   node bin/calendar-sync-check.js <mailbox address> [--db path]
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { calendarFor } from '../src/calendar.js';
import { eventRow } from '../src/calendar-sync.js';
import { SaTokens, signerFromConfig } from '../src/sa-token.js';

const args = process.argv.slice(2);
const address = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db')?.toLowerCase();
const dbFlag = args.indexOf('--db');
if (!address) { console.error('usage: node bin/calendar-sync-check.js <mailbox address> [--db path]'); process.exit(2); }
const config = loadConfig();
const db = new Database(dbFlag >= 0 ? args[dbFlag + 1] : join(config.dataDir, 'tobira-inbox.db'), { readonly: true, fileMustExist: true });
const mbx = db.prepare('SELECT * FROM mailboxes WHERE lower(address) = ?').get(address);
if (!mbx) { console.error(`no mailbox ${address}`); process.exit(1); }
const tz = db.prepare('SELECT timezone FROM businesses WHERE id = ?').get(mbx.business_id)?.timezone || 'Asia/Tokyo';
const signer = signerFromConfig({ db, config });
const cal = calendarFor(mbx, { db, config, saTokens: signer ? new SaTokens({ db, config, signer }) : null });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
const monday = new Date(Date.parse(`${today}T00:00:00Z`) - dow * 86400_000 - 14 * 3600_000);
const { items } = await cal.listEvents(address, { timeMin: monday.toISOString(), timeMax: new Date(monday.getTime() + 8 * 86400_000).toISOString() });
const rows = items.filter((e) => e.status !== 'cancelled').map((e) => eventRow(e, tz))
  .map((r) => ({ start: r.start_utc && new Date(r.start_utc).toLocaleString('ja-JP', { timeZone: tz }), end: r.end_utc && new Date(r.end_utc).toLocaleString('ja-JP', { timeZone: tz }), allDay: !!r.all_day, title: r.title, visibility: r.visibility }));
console.log(JSON.stringify({ mailbox: address, timezone: tz, weekOf: today, count: rows.length, events: rows }, null, 2));
db.close();
