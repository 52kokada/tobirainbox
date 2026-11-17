// apps/server/src/playbook-sync.js — load an outside playbook into playbook_rules.
// The caller sends the whole set under one prefix ('tobira-playbook:'); rules with
// that prefix are added or updated in place, and ones no longer sent are retired
// (status 'rejected'), so the playbook stays the single source. Rules written by
// owners or proposed by the AI (no external_key) are never changed.
import { newId } from './store.js';

const PHASES = new Set(['first', 'sample', 'deal', 'active', 'after']);

export function syncPlaybook(db, { businessId, prefix, rules }) {
  if (!/^[a-z0-9-]+:$/.test(prefix ?? '')) throw new Error('prefix must look like "name:"');
  const clean = [];
  for (const r of rules ?? []) {
    if (!r?.key || typeof r.text !== 'string' || !r.text.trim()) throw new Error('each rule needs key and text');
    if (r.text.length > 1000) throw new Error(`rule ${r.key} is over 1000 characters`);
    clean.push({ key: prefix + r.key, text: r.text.trim(), phase: PHASES.has(r.phase) ? r.phase : null, label: r.label || null });
  }
  const out = { added: 0, updated: 0, unchanged: 0, retired: 0 };
  db.transaction(() => {
    const keep = new Set();
    for (const r of clean) {
      keep.add(r.key);
      const cur = db.prepare('SELECT id, text, phase, label_key, status FROM playbook_rules WHERE business_id = ? AND external_key = ?').get(businessId, r.key);
      if (!cur) {
        db.prepare("INSERT INTO playbook_rules (id, business_id, label_key, text, source, status, phase, external_key) VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?)")
          .run(newId(), businessId, r.label, r.text, r.phase, r.key);
        out.added++;
      } else if (cur.text !== r.text || cur.phase !== r.phase || cur.label_key !== r.label || cur.status !== 'active') {
        db.prepare("UPDATE playbook_rules SET text = ?, phase = ?, label_key = ?, status = 'active' WHERE id = ?").run(r.text, r.phase, r.label, cur.id);
        out.updated++;
      } else out.unchanged++;
    }
    for (const row of db.prepare("SELECT id, external_key FROM playbook_rules WHERE business_id = ? AND external_key LIKE ? AND status = 'active'").all(businessId, `${prefix}%`)) {
      if (!keep.has(row.external_key)) { db.prepare("UPDATE playbook_rules SET status = 'rejected' WHERE id = ?").run(row.id); out.retired++; }
    }
  })();
  return out;
}
