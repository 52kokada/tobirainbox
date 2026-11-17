// apps/server/src/routes/push.js — subscribe this device to notifications.
import { newId } from '../store.js';
import { currentSession } from '../auth.js';

export function registerPushRoutes(app, { db, config }) {
  const member = (req, reply) => {
    const s = currentSession(db, req, config.masterKey);
    if (!s) { reply.code(401).send({ error: 'sign in required' }); return null; }
    return s;
  };

  app.get('/api/push/key', async (req, reply) => {
    if (!member(req, reply)) return;
    if (!config.vapidPublicKey) return reply.code(503).send({ error: 'push not configured' });
    return { key: config.vapidPublicKey };
  });

  app.post('/api/push/subscribe', async (req, reply) => {
    const s = member(req, reply); if (!s) return;
    const sub = req.body?.subscription;
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return reply.code(400).send({ error: 'bad subscription' });
    db.transaction(() => {
      db.prepare(`INSERT INTO push_subscriptions (id, business_id, user_id, endpoint, keys_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (endpoint) DO UPDATE SET business_id = excluded.business_id, user_id = excluded.user_id, keys_json = excluded.keys_json, last_error = NULL`)
        .run(newId(), s.business.id, s.user.id, sub.endpoint, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }));
      // Do not flood a new device with old mail: only mail arriving from now on.
      db.prepare(`INSERT OR IGNORE INTO notifications (thread_id, message_id, business_id)
        SELECT id, last_message_id, business_id FROM threads WHERE business_id = ? AND last_message_id IS NOT NULL`).run(s.business.id);
    })();
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req, reply) => {
    const s = member(req, reply); if (!s) return;
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint ?? ''), s.user.id);
    return { ok: true };
  });
}
