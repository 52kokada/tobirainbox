// apps/server/src/mailboxes.js — shared helpers: a Gmail client for a mailbox, and
// relabelling a thread (used by the console and the admin page).
import { redact, parseFrom } from '@tobira-inbox/engine';
import { Store } from './store.js';
import { tokenFor } from './token-source.js';
import { Gmail } from './gmail.js';
import { emit } from './cockpit-outbox.js';

export const LABEL_PREFIX = 'TobirAInbox';

export function gmailFor(mailbox, config, factory) {
  const opts = tokenFor(mailbox, 'gmail', config);
  return factory ? factory(opts) : new Gmail(opts);
}

/**
 * A person sets a thread's label. Saves a correction (contact details removed) that
 * the sorter learns from, and mirrors the label into Gmail (best effort).
 */
export async function relabelThread({ db, config, threadId, businessId, to, userId = null, gmailFactory }) {
  const store = new Store(db, businessId);
  const t = store.thread(threadId);
  if (!t) return { ok: false, code: 404, error: 'no thread' };
  const label = store.labels().find((l) => l.key === to);
  if (!label) return { ok: false, code: 400, error: 'unknown label' };
  const from = parseFrom(t.cache_from ?? '');
  db.transaction(() => {
    db.prepare("UPDATE threads SET label_key = ?, label_by = 'person', updated_at = ? WHERE id = ? AND business_id = ?")
      .run(to, new Date().toISOString(), t.id, businessId);
    if (to !== t.label_key) {
      db.prepare(`INSERT INTO label_corrections (business_id, thread_id, from_label, to_label, from_domain, subject_redacted, excerpt_redacted, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(businessId, t.id, t.label_key, to, from.split('@')[1] ?? null,
        redact(t.cache_subject ?? '').slice(0, 120), redact(t.cache_snippet ?? '').slice(0, 200), userId);
    }
    store.audit(userId, 'relabel', t.id, { from: t.label_key, to });
    if (to !== t.label_key) {
      const mbx = store.mailbox(t.mailbox_id);
      emit(db, { businessId, type: 'relabelled', mailbox: mbx?.address, thread: t.gmail_thread_id, gmailMessageId: t.last_message_id,
        from: t.cache_from, label: to, extra: { previousLabel: t.label_key } });
    }
  })();
  try {
    const mbx = store.mailbox(t.mailbox_id);
    if (mbx?.write_labels && mbx.token_enc && config.clientId) {
      const g = gmailFor(mbx, config, gmailFactory);
      const all = (await g.labels()).filter((l) => l.name.startsWith(`${LABEL_PREFIX}/`));
      let target = all.find((l) => l.name === `${LABEL_PREFIX}/${label.ja}`);
      if (!target) target = await g.createLabel(`${LABEL_PREFIX}/${label.ja}`);
      await g.modifyThread(t.gmail_thread_id, { add: [target.id], remove: all.filter((l) => l.id !== target.id).map((l) => l.id) });
    }
  } catch { /* Gmail label mirror is best effort; the console is the source of truth */ }
  return { ok: true };
}
