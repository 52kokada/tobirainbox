// apps/server/src/push.js — browser push (Web Push, VAPID). Notifies a company's
// members when mail that needs a reply, or a 要確認 email, arrives. The payload
// carries only the label, sender name and subject; the body stays in Gmail.
import webpush from 'web-push';
import { Store } from './store.js';

export function configurePush(config) {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) return false;
  webpush.setVapidDetails(config.vapidSubject || 'mailto:leo@example.com', config.vapidPublicKey, config.vapidPrivateKey);
  return true;
}

const senderName = (from) => String(from ?? '').replace(/<[^>]*>/, '').replace(/"/g, '').trim() || from;

/**
 * Find threads with a new message that a person should look at and notify each
 * member's subscribed devices once. `send` is injectable for tests.
 */
export async function notifyNew(db, { send = (sub, payload) => webpush.sendNotification(sub, payload) } = {}) {
  const businesses = db.prepare('SELECT DISTINCT business_id AS id FROM push_subscriptions').all();
  const out = { notified: 0, failed: 0 };
  for (const { id } of businesses) {
    const store = new Store(db, id);
    const labels = store.labels();
    const wanted = new Set([...labels.filter((l) => l.autoDraft).map((l) => l.key), 'unconfirmed']);
    const threads = db.prepare(`SELECT t.* FROM threads t WHERE t.business_id = ? AND t.status IN ('new','drafted') AND t.last_message_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.thread_id = t.id AND n.message_id = t.last_message_id)`).all(id)
      .filter((t) => wanted.has(t.label_key));
    if (!threads.length) continue;
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE business_id = ?').all(id);
    for (const t of threads) {
      const label = labels.find((l) => l.key === t.label_key);
      const payload = JSON.stringify({
        title: `${label?.ja ?? t.label_key}｜${senderName(t.cache_from)}`,
        body: t.cache_subject ?? '',
        url: `/#t=${t.id}`,
        tag: t.id,
      });
      let delivered = 0;
      for (const sub of subs) {
        try {
          await send({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) }, payload);
          delivered += 1;
        } catch (err) {
          out.failed += 1;
          // 404/410: the browser dropped the subscription — forget it.
          if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
          else db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').run(String(err.message).slice(0, 200), sub.id);
        }
      }
      db.prepare('INSERT OR IGNORE INTO notifications (thread_id, message_id, business_id, delivered) VALUES (?, ?, ?, ?)').run(t.id, t.last_message_id, id, delivered);
      out.notified += 1;
    }
  }
  return out;
}

/** Send one notification to the devices of a company's owners (or everyone, if no owner subscribed). */
export async function notifyOwners(db, businessId, message, { send = (sub, payload) => webpush.sendNotification(sub, payload) } = {}) {
  let subs = db.prepare(`SELECT p.* FROM push_subscriptions p JOIN users u ON u.id = p.user_id WHERE p.business_id = ? AND u.role = 'owner'`).all(businessId);
  if (!subs.length) subs = db.prepare('SELECT * FROM push_subscriptions WHERE business_id = ?').all(businessId);
  const payload = JSON.stringify(message);
  let delivered = 0;
  for (const sub of subs) {
    try { await send({ endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) }, payload); delivered += 1; } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
    }
  }
  return delivered;
}
