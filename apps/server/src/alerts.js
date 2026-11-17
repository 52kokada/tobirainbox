// apps/server/src/alerts.js — tell a person when something needs them: shown as a bar in the console,
// pushed to subscribed phones, and sent to the CRM (which can forward it to Discord). One open alert per
// problem (deduped by key); it closes itself when the problem goes away.
import { newId } from './store.js';
import { notifyOwners } from './push.js';
import { emit } from './cockpit-outbox.js';

export function raiseAlert(db, { businessId, kind, key, title, body = '', url = '/' }, { push = notifyOwners } = {}) {
  const r = db.prepare('INSERT OR IGNORE INTO alerts (id, business_id, kind, key, title, body, url) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(newId(), businessId, kind, String(key), title, String(body).slice(0, 500), url);
  if (!r.changes) return false; // already open: no repeat pings
  push(db, businessId, { title, body: String(body).slice(0, 180), url }).catch?.(() => {});
  try { emit(db, { businessId, type: 'alert', extra: { kind, title, body: String(body).slice(0, 300) } }); } catch { /* cockpit optional */ }
  return true;
}

export function resolveAlerts(db, { businessId, kind, key }) {
  return db.prepare('UPDATE alerts SET resolved_at = ? WHERE business_id = ? AND kind = ? AND key = ? AND resolved_at IS NULL')
    .run(new Date().toISOString(), businessId, kind, String(key)).changes;
}

export function openAlerts(db, businessId) {
  return db.prepare('SELECT id, kind, title, body, url, created_at FROM alerts WHERE business_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 10').all(businessId);
}
