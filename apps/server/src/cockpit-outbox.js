// apps/server/src/cockpit-outbox.js — events for the optional external CRM backend, D31, Phase 6.
// Written in the same transaction as the change they describe; delivered later by
// the worker with retries. Inert until COCKPIT_EVENTS_URL + COCKPIT_EVENTS_TOKEN are set.
import { parseFrom } from '@tobira-inbox/engine';

/** Our label → CRM's outreach verdict vocabulary. */
export function outreachVerdict(label) {
  if (['inquiry', 'question', 'booking', 'booking_change'].includes(label)) return 'positive';
  if (label === 'decline') return 'negative';
  if (label === 'optout') return 'optout';
  if (label === 'auto_reply') return 'auto';
  if (label === 'unconfirmed') return 'unclear';
  return null; // notice, spam, sales pitch, complaint, other: not an outreach verdict
}

/** Queue an event if this company reports to cockpit. Safe to call inside a transaction. */
export function emit(db, { businessId, type, mailbox, thread, gmailMessageId, from, label, extra = {} }) {
  const b = db.prepare('SELECT report_to_cockpit FROM businesses WHERE id = ?').get(businessId);
  if (!b?.report_to_cockpit) return false;
  const payload = {
    type, at: new Date().toISOString(), mailbox,
    gmailThreadId: thread ?? null, gmailMessageId: gmailMessageId ?? null,
    fromEmail: from ? parseFrom(from) : null, label: label ?? null, outreachVerdict: label ? outreachVerdict(label) : null, ...extra,
  };
  db.prepare('INSERT INTO outbox_events (business_id, type, payload_json) VALUES (?, ?, ?)').run(businessId, type, JSON.stringify(payload));
  return true;
}

const MAX_ATTEMPTS = 20;

/** Deliver pending events in order, in batches. Stops at the first failure (keeps order). */
export async function flushOutbox(db, config, { fetchImpl = fetch, batch = 50 } = {}) {
  if (!config.cockpitEventsUrl || !config.cockpitEventsToken) return { skipped: 'not configured' };
  const rows = db.prepare("SELECT * FROM outbox_events WHERE status = 'pending' ORDER BY id LIMIT ?").all(batch);
  if (!rows.length) return { delivered: 0 };
  try {
    const res = await fetchImpl(config.cockpitEventsUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.cockpitEventsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'tobira-inbox', events: rows.map((r) => ({ eventId: `tobira-inbox:${r.id}`, ...JSON.parse(r.payload_json) })) }),
    });
    if (!res.ok) throw new Error(`cockpit ${res.status}`);
    const now = new Date().toISOString();
    db.transaction(() => { for (const r of rows) db.prepare("UPDATE outbox_events SET status = 'delivered', delivered_at = ?, last_error = NULL WHERE id = ?").run(now, r.id); })();
    return { delivered: rows.length };
  } catch (err) {
    db.transaction(() => {
      for (const r of rows) {
        db.prepare("UPDATE outbox_events SET attempts = attempts + 1, last_error = ?, status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?")
          .run(String(err.message).slice(0, 300), MAX_ATTEMPTS, r.id);
      }
    })();
    return { delivered: 0, error: err.message };
  }
}
