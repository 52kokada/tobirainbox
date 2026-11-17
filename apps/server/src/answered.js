// apps/server/src/answered.js — one rule, used everywhere: a thread is answered when the latest real message
// (not a Gmail reaction, not a draft) was written by our side: this mailbox, a teammate, or anyone on our domain.
// Answered threads leave 要対応 and never get an AI draft, however the reply was sent (Gmail, a teammate's box, CC).
import { parseFrom } from '@tobira-inbox/engine';
import { parseMessage } from './gmail.js';
import { ownMatcher } from './ingest.js';

export function lastWord(db, businessId, rawMessages) {
  const isOwn = ownMatcher(db, businessId);
  const msgs = (rawMessages ?? []).map((m) => (m.payload ? parseMessage(m) : m)).filter((m) => !m.reaction && !(m.labelIds ?? []).includes('DRAFT'));
  const last = msgs.at(-1);
  if (!last) return { last: null, ours: false };
  return { last, ours: (last.labelIds ?? []).includes('SENT') || isOwn(parseFrom(last.from)) };
}

const addresses = (v) => String(v ?? '').split(',').map((x) => parseFrom(x)).filter(Boolean);

/**
 * A teammate owns it: the customer wrote To someone on our side and this mailbox is only in CC.
 * (Sent To this mailbox directly = ours to answer.)
 */
export function teammateOwns(db, businessId, mailboxAddress, msg) {
  if (!msg) return false;
  const isOwn = ownMatcher(db, businessId); const me = String(mailboxAddress).toLowerCase();
  const to = addresses(msg.to);
  return !to.includes(me) && to.some((a) => isOwn(a));
}

/** Close an open thread whose latest message is ours, or that a teammate owns (we are only CC'd). */
export function closeIfAnswered(db, thread, rawMessages) {
  if (!['new', 'drafted'].includes(thread.status)) return false;
  const { last, ours } = lastWord(db, thread.business_id, rawMessages);
  const mbx = db.prepare('SELECT address FROM mailboxes WHERE id = ?').get(thread.mailbox_id);
  if (!ours && !teammateOwns(db, thread.business_id, mbx?.address, last)) return false;
  db.prepare("UPDATE threads SET status = 'done', updated_at = ? WHERE id = ? AND status IN ('new','drafted')").run(new Date().toISOString(), thread.id);
  db.prepare("UPDATE drafts SET status = 'discarded' WHERE thread_id = ? AND status = 'open'").run(thread.id);
  return true;
}
