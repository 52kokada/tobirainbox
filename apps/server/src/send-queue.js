// apps/server/src/send-queue.js — the only path to sending (D3, D23, D33).
//
// Invariants (each has a test):
//   1. A send exists only because a signed-in user of the same business clicked
//      Send: queueSend needs a userId that belongs to the business.
//   2. A draft with any 【要確認】 blank left cannot be queued.
//   3. One draft version can be queued once (idempotency key), so a double
//      click or a retry never sends twice.
//   4. Nothing leaves before undo_until (business undo window, default 30 s,
//      clamped to 5–30); cancelSend before then stops it for good.
//   5. A mailbox still in shadow mode never sends.
//   6. A partner (D8) sends only from a mailbox an owner allowed.
//   7. 予約送信: a scheduled send waits until its time (1 minute to 60 days ahead) and can be cancelled or
//      moved until then. If a newer message reaches the thread first, it is held, never sent stale.
import { hasBlanks } from '@tobira-inbox/engine';
import { accessScope, canSendFrom } from './partner.js';
import { newId } from './store.js';
import { closeCopies } from './copies.js';
import { raiseAlert } from './alerts.js';

export const DEFAULT_UNDO_SECONDS = 30;
export const MAX_ATTEMPTS = 3;
export const MIN_SCHEDULE_MS = 60_000;
export const MAX_SCHEDULE_MS = 60 * 86400_000;

export class SendRefused extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const clampUndo = (s) => Math.min(30, Math.max(5, Number.isFinite(s) ? s : DEFAULT_UNDO_SECONDS));

/** A schedule time as an ISO string, or SendRefused when it is unreadable, too soon or too far ahead. */
function scheduleTime(at, now) {
  const ms = new Date(at).getTime();
  if (!Number.isFinite(ms)) throw new SendRefused('bad_time', 'could not read the time');
  if (ms < now.getTime() + MIN_SCHEDULE_MS) throw new SendRefused('too_soon', 'pick a time at least a minute from now');
  if (ms > now.getTime() + MAX_SCHEDULE_MS) throw new SendRefused('too_far', 'pick a time within 60 days');
  return new Date(ms).toISOString();
}

/**
 * @param {import('./store.js').Store} store
 * @param {{userId:string, draftId:string, bodyText?:string, sendAt?:string, now?:Date}} req
 *   bodyText: the text as finally edited in the console; saved as a new user
 *   draft version first when it differs from the stored draft.
 *   sendAt: 予約送信 — when to send (ISO); omitted = now, after the undo window.
 */
export function queueSend(store, { userId, draftId, bodyText, sendAt, now = new Date() }) {
  const scheduledAt = sendAt != null && sendAt !== '' ? scheduleTime(sendAt, now) : null;
  const user = store.user(userId);
  if (!user) throw new SendRefused('not_a_member', 'user does not belong to this business');
  let draft = store.draft(draftId);
  if (!draft) throw new SendRefused('no_draft', 'draft not found');
  const thread = store.thread(draft.thread_id);
  const mailbox = store.mailbox(thread.mailbox_id);
  // D8 partner: sends only from a mailbox an owner allowed (checked here too, not just in the route).
  if (!canSendFrom(accessScope(store.db, user), thread.mailbox_id)) throw new SendRefused('partner_cannot_send', 'this mailbox has not allowed this partner to send');
  if (mailbox?.mode !== 'live') throw new SendRefused('mailbox_not_live', 'mailbox is not live (shadow or paused)');

  if (bodyText != null && bodyText !== draft.body_text) {
    draft = store.draft(store.saveDraft({ threadId: thread.id, bodyText, createdBy: 'user' }));
  }
  if (hasBlanks(draft.body_text)) throw new SendRefused('blanks_left', 'fill every 【要確認】 before sending');
  if (draft.status !== 'open') throw new SendRefused('already_queued', 'this draft was already queued');

  const undo = clampUndo(store.business()?.undo_seconds);
  // A scheduled send can be undone right up to its time; an ordinary one for the business's undo window.
  const undoUntil = scheduledAt ?? new Date(now.getTime() + undo * 1000).toISOString();
  const id = newId();
  const key = `${draft.thread_id}:${draft.version}`;
  try {
    store.db.transaction(() => {
      store.db.prepare(`INSERT INTO sends (id, business_id, draft_id, user_id, idempotency_key, body_text, queued_at, undo_until, scheduled_at, after_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, store.businessId, draft.id, userId, key, draft.body_text, now.toISOString(), undoUntil,
        scheduledAt, scheduledAt ? thread.last_message_id ?? null : null);
      store.db.prepare("UPDATE drafts SET status = 'queued' WHERE id = ? AND business_id = ?").run(draft.id, store.businessId);
    })();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new SendRefused('already_queued', 'this draft was already queued');
    throw err;
  }
  store.audit(userId, scheduledAt ? 'send_scheduled' : 'send_queued', id, { draftId: draft.id, undoUntil });
  return { sendId: id, undoUntil, scheduledAt };
}

/**
 * Move a scheduled send to another time, or send it now (`now: true` gives it the ordinary undo window).
 * Only while it is still waiting; the same checks as when it was scheduled.
 */
export function rescheduleSend(store, { userId, sendId, sendAt, sendNow = false, now = new Date() }) {
  const user = store.user(userId);
  if (!user) throw new SendRefused('not_a_member', 'user does not belong to this business');
  const row = store.db.prepare('SELECT * FROM sends WHERE id = ? AND business_id = ?').get(sendId, store.businessId);
  if (!row) throw new SendRefused('no_send', 'send not found');
  if (row.status !== 'queued' || !row.scheduled_at || new Date(row.undo_until) <= now) throw new SendRefused('too_late', 'this send has already gone out');
  const draft = store.draft(row.draft_id);
  const thread = store.thread(draft.thread_id);
  if (!canSendFrom(accessScope(store.db, user), thread.mailbox_id)) throw new SendRefused('partner_cannot_send', 'this mailbox has not allowed this partner to send');
  let undoUntil; let scheduledAt;
  if (sendNow) {
    undoUntil = new Date(now.getTime() + clampUndo(store.business()?.undo_seconds) * 1000).toISOString();
    scheduledAt = null;
  } else {
    scheduledAt = scheduleTime(sendAt, now); undoUntil = scheduledAt;
  }
  store.db.prepare("UPDATE sends SET undo_until = ?, scheduled_at = ? WHERE id = ? AND status = 'queued'").run(undoUntil, scheduledAt, row.id);
  store.audit(userId, sendNow ? 'send_now' : 'send_rescheduled', row.id, { undoUntil });
  return { sendId: row.id, undoUntil, scheduledAt };
}

export function cancelSend(store, { userId, sendId, now = new Date() }) {
  if (!store.user(userId)) throw new SendRefused('not_a_member', 'user does not belong to this business');
  const row = store.db.prepare('SELECT * FROM sends WHERE id = ? AND business_id = ?').get(sendId, store.businessId);
  if (!row) throw new SendRefused('no_send', 'send not found');
  if (row.status !== 'queued' || new Date(row.undo_until) <= now) {
    throw new SendRefused('too_late', 'the undo window has passed');
  }
  store.db.transaction(() => {
    // Free the idempotency key so the same draft can be sent again after an undo.
    store.db.prepare("UPDATE sends SET status = 'cancelled', finished_at = ?, idempotency_key = idempotency_key || ':undone:' || id WHERE id = ?").run(now.toISOString(), sendId);
    store.db.prepare("UPDATE drafts SET status = 'open' WHERE id = ?").run(row.draft_id);
    // D41: undoing a confirmation email also cancels its Google invite. It was never sent (invites go out only
    // after delivery), so this is a row update, never a Google call.
    store.db.prepare(`UPDATE meetings SET invite_state = 'none' WHERE invite_state = 'queued'
      AND id = (SELECT meeting_id FROM drafts WHERE id = ? AND meeting_purpose = 'confirm')`).run(row.draft_id);
    // A cancelled 予約送信 means the reply is still owed: bring the conversation back if anything closed it meanwhile.
    if (row.scheduled_at) {
      store.db.prepare("UPDATE threads SET status = 'drafted', updated_at = ? WHERE id = (SELECT thread_id FROM drafts WHERE id = ?) AND status = 'done'")
        .run(now.toISOString(), row.draft_id);
    }
  })();
  store.audit(userId, 'send_undone', sendId);
  return true;
}

/**
 * 予約送信 safety: a scheduled reply whose thread received anything newer since it was scheduled is held
 * (cancelled, draft reopened, owner alerted), right away rather than at its time, so the new message
 * shows up under 要対応 instead of waiting behind the schedule. Runs on every worker tick.
 */
export function holdStale(db) {
  const stale = db.prepare(`SELECT s.*, t.id AS thread_id, t.cache_subject FROM sends s JOIN drafts d ON d.id = s.draft_id JOIN threads t ON t.id = d.thread_id
    WHERE s.status = 'queued' AND s.scheduled_at IS NOT NULL AND s.after_message_id IS NOT NULL AND t.last_message_id IS NOT NULL AND t.last_message_id != s.after_message_id`).all();
  const out = [];
  for (const s of stale) {
    const held = db.transaction(() => {
      const r = db.prepare("UPDATE sends SET status = 'cancelled', error = 'held: a newer message arrived', finished_at = ?, idempotency_key = idempotency_key || ':held:' || id WHERE id = ? AND status = 'queued'")
        .run(new Date().toISOString(), s.id);
      if (r.changes !== 1) return false;
      db.prepare("UPDATE drafts SET status = 'open' WHERE id = ? AND status = 'queued'").run(s.draft_id);
      db.prepare("INSERT INTO audit_log (business_id, user_id, action, target) VALUES (?, ?, 'send_held', ?)").run(s.business_id, s.user_id, s.id);
      return true;
    })();
    if (!held) continue;
    raiseAlert(db, { businessId: s.business_id, kind: 'send_failed', key: s.id, // alerts.kind CHECK allows three kinds; held = not sent
      title: `予約送信を止めました：${s.cache_subject ?? ''}`.slice(0, 120),
      body: '予約したあとに新しいメールが届いたので、送らずに止めました。内容を確認して、もう一度送ってください。', url: `/#t=${s.thread_id}` });
    out.push({ id: s.id, status: 'held' });
  }
  return out;
}

/**
 * Deliver every queued send whose undo window has closed. Claims each row
 * (queued → sending) before calling the transport so two workers cannot both
 * send it. `transport.send({send, draft, thread, mailbox})` → {messageId}.
 * Runs across businesses; each row is handled under its own business id.
 */
export async function deliverDue(db, transport, { now = new Date(), onSent } = {}) {
  const results = holdStale(db);
  const due = db.prepare("SELECT * FROM sends WHERE status = 'queued' AND undo_until <= ? ORDER BY undo_until")
    .all(now.toISOString());
  for (const s of due) {
    const claimed = db.prepare("UPDATE sends SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'").run(s.id);
    if (claimed.changes !== 1) continue;
    const draft = db.prepare('SELECT * FROM drafts WHERE id = ? AND business_id = ?').get(s.draft_id, s.business_id);
    const thread = db.prepare('SELECT * FROM threads WHERE id = ? AND business_id = ?').get(draft.thread_id, s.business_id);
    const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND business_id = ?').get(thread.mailbox_id, s.business_id);
    try {
      if (mailbox.mode !== 'live') throw new Error('mailbox is not live');
      if (hasBlanks(s.body_text)) throw new SendRefused('blanks_left', 'fill every blank or candidate date/time before sending');
      const delivered = await transport.send({ send: s, draft, thread, mailbox });
      const { messageId } = delivered;
      db.transaction(() => {
        db.prepare('UPDATE thread_attachments SET sent_at = ? WHERE thread_id = ? AND sent_at IS NULL').run(new Date().toISOString(), thread.id);
        db.prepare("UPDATE sends SET status = 'sent', gmail_message_id = ?, finished_at = ?, error = NULL WHERE id = ?")
          .run(messageId, new Date().toISOString(), s.id);
        db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(draft.id);
        db.prepare("UPDATE threads SET status = 'sent', updated_at = ? WHERE id = ?").run(new Date().toISOString(), thread.id);
        closeCopies(db, thread.id, 'sent');
        db.prepare("INSERT INTO audit_log (business_id, user_id, action, target) VALUES (?, ?, 'sent', ?)").run(s.business_id, s.user_id, s.id);
        onSent?.({ send: s, thread, mailbox, delivered });
      })();
      results.push({ id: s.id, status: 'sent' });
    } catch (err) {
      const attempts = s.attempts + 1;
      const status = err instanceof SendRefused || attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
      db.prepare('UPDATE sends SET status = ?, error = ?, finished_at = ? WHERE id = ?')
        .run(status, String(err.message).slice(0, 500), status === 'failed' ? new Date().toISOString() : null, s.id);
      results.push({ id: s.id, status, error: err.message });
      if (status === 'failed') {
        raiseAlert(db, { businessId: s.business_id, kind: 'send_failed', key: s.id, title: `送信できませんでした：${thread.cache_subject ?? ''}`.slice(0, 120),
          body: String(err.message), url: `/#t=${thread.id}` });
      }
    }
  }
  return results;
}
