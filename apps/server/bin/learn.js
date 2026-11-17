#!/usr/bin/env node
// Turn learning on for one business now: past sent replies → examples (D4), the website → fact
// candidates (D8), then AI rule suggestions from the examples (D21). Same code the console buttons run.
//   node bin/learn.js <businessId> [websiteUrl]
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createAi } from '../src/ai.js';
import { gmailFor } from '../src/mailboxes.js';
import { importHistory, proposeRules } from '../src/learning.js';
import { readWebsite } from '../src/website.js';

const args = process.argv.slice(2); const rulesOnly = args.includes('--rules-only');
const [businessId, siteArg] = args.filter((a) => !a.startsWith('--'));
if (!businessId) { console.error('usage: node bin/learn.js <businessId> [websiteUrl]'); process.exit(2); }
const config = loadConfig();
const db = openDb(join(config.dataDir, 'tobira-inbox.db'));
const ai = config.anthropicApiKey ? createAi({ apiKey: config.anthropicApiKey, db }) : null;

const out = { history: [], website: null, rules: null };
if (!rulesOnly) for (const m of db.prepare("SELECT * FROM mailboxes WHERE business_id = ? AND status = 'connected'").all(businessId)) {
  try { const r = await importHistory(db, { mailbox: m, gmail: gmailFor(m, config), maxThreads: 100 }); out.history.push({ mailbox: m.address, ...r }); }
  catch (err) { out.history.push({ mailbox: m.address, error: err.message }); }
}
const site = siteArg ?? db.prepare('SELECT website_url FROM businesses WHERE id = ?').get(businessId)?.website_url;
if (site && !rulesOnly) {
  db.prepare('UPDATE businesses SET website_url = ? WHERE id = ?').run(site, businessId);
  try { out.website = await readWebsite({ db, ai, businessId, url: site, config }); } catch (err) { out.website = { error: err.message }; }
}
try {
  out.rules = await proposeRules(db, { ai, businessId, config });
  db.prepare('UPDATE businesses SET rules_proposed_at = ? WHERE id = ?').run(new Date().toISOString(), businessId);
} catch (err) { out.rules = { error: err.message }; }
console.log(JSON.stringify(out, null, 1));
