#!/usr/bin/env node
// Create (or find) a business's 調整中 calendar, or with --shadow its "(test)" calendar, as the hold
// calendar owner mailbox (plan step 5, D43), store its id, and share it with each connected mailbox as
// writer when Google allows the ACL write (D51). Idempotent. Starts no server or worker and imports no
// send, outbox, ingest or label module.
//   node bin/calendar-setup.js <businessId> [--shadow] [--no-share] [--db path]
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { calendarFor, ensureHoldCalendar, shareHoldCalendar } from '../src/calendar.js';
import { SaTokens, signerFromConfig } from '../src/sa-token.js';

const args = process.argv.slice(2);
const businessId = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db');
const dbFlag = args.indexOf('--db');
if (!businessId) { console.error('usage: node bin/calendar-setup.js <businessId> [--shadow] [--no-share] [--db path]'); process.exit(2); }
const config = loadConfig();
const db = new Database(dbFlag >= 0 ? args[dbFlag + 1] : join(config.dataDir, 'tobira-inbox.db'), { fileMustExist: true });
const signer = signerFromConfig({ db, config });
const saTokens = signer ? new SaTokens({ db, config, signer }) : null;
const clientFor = (mailbox) => calendarFor(mailbox, { db, config, saTokens });
const shadow = args.includes('--shadow');
try {
  const r = await ensureHoldCalendar({ db, businessId, shadow, clientFor });
  const share = args.includes('--no-share') ? null : await shareHoldCalendar({ db, businessId, calendarId: r.id, owner: r.owner, clientFor });
  console.log(JSON.stringify({ businessId, shadow, calendarId: r.id, created: r.created, owner: r.owner.address, share }, null, 2));
  process.exitCode = share?.failed.length ? 1 : 0;
} catch (err) {
  console.error(JSON.stringify({ error: err.code ?? 'error', message: err.message }));
  process.exitCode = 1;
} finally { db.close(); }
