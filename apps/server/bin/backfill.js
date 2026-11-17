#!/usr/bin/env node
// Full mail history into 履歴 for every connected mailbox of a business (read-only on Gmail).
//   node bin/backfill.js <businessId> [maxThreadsPerMailbox]
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createAi } from '../src/ai.js';
import { gmailFor } from '../src/mailboxes.js';
import { backfillMailbox } from '../src/backfill.js';

const [businessId, max] = process.argv.slice(2);
if (!businessId) { console.error('usage: node bin/backfill.js <businessId> [maxThreadsPerMailbox]'); process.exit(2); }
const config = loadConfig();
const db = openDb(join(config.dataDir, 'tobira-inbox.db'));
const ai = config.anthropicApiKey ? createAi({ apiKey: config.anthropicApiKey, db }) : null;
for (const m of db.prepare("SELECT * FROM mailboxes WHERE business_id = ? AND status = 'connected'").all(businessId)) {
  const r = await backfillMailbox({ db, mailbox: m, gmail: gmailFor(m, config), ai, config, maxThreads: Number(max) || 20000,
    onProgress: (p) => console.log(JSON.stringify(p)) });
  console.log(JSON.stringify({ done: m.address, ...r }));
}
