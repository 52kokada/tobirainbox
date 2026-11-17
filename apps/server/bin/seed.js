// node apps/server/bin/seed.js apps/server/seeds/example.json
// Loads voices (one per mailbox, D32), playbook rules (D21) and facts (D8) for a
// business. Idempotent: replaces this business's seeded playbook/facts/voices.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { newId } from '../src/store.js';

const RULE = '━'.repeat(17);
const block = (v) => v.signature ?? [v.surname, RULE, 'Example Studio', v.fullName, `Mail: ${v.address}`, 'URL: https://example.com', RULE].join('\n');

export function seedBusiness(db, seed) {
  const biz = db.prepare('SELECT id FROM businesses WHERE name = ?').get(seed.business);
  if (!biz) throw new Error(`business not found: ${seed.business}`);
  db.transaction(() => {
    for (const v of seed.voices) {
      const existing = db.prepare('SELECT id FROM voice_profiles WHERE business_id = ? AND mailbox_address = ?').get(biz.id, v.address);
      const id = existing?.id ?? newId();
      if (existing) {
        db.prepare('UPDATE voice_profiles SET full_name = ?, style = ?, signature = ? WHERE id = ?').run(v.fullName, seed.style, block(v), id);
      } else {
        db.prepare('INSERT INTO voice_profiles (id, business_id, full_name, style, signature, mailbox_address) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, biz.id, v.fullName, seed.style, block(v), v.address);
      }
      db.prepare('UPDATE mailboxes SET voice_profile_id = ? WHERE business_id = ? AND LOWER(address) = ?').run(id, biz.id, v.address.toLowerCase());
    }
    db.prepare("DELETE FROM playbook_rules WHERE business_id = ? AND source = 'owner'").run(biz.id);
    for (const r of seed.playbook) {
      db.prepare("INSERT INTO playbook_rules (id, business_id, label_key, text, source, status) VALUES (?, ?, ?, ?, 'owner', 'active')")
        .run(newId(), biz.id, r.label ?? null, r.text);
    }
    for (const [key, value] of Object.entries(seed.facts)) {
      db.prepare(`INSERT INTO facts (id, business_id, key, value, source) VALUES (?, ?, ?, ?, 'owner')
        ON CONFLICT (business_id, key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .run(newId(), biz.id, key, value);
    }
  })();
  return biz.id;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed.js')) {
  const file = process.argv[2];
  if (!file) { console.error('usage: seed.js <seed.json>'); process.exit(2); }
  const db = openDb(join(loadConfig().dataDir, 'tobira-inbox.db'));
  console.log('seeded', seedBusiness(db, JSON.parse(readFileSync(file, 'utf8'))));
  db.close();
}
