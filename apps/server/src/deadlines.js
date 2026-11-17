// apps/server/src/deadlines.js — deadlines on the calendar (grill round 10: D54-D58).
// D58: a general deadline item; only the 'preview' type is switched on. D54: the date-detection model call
// also answers "does the client want a preview?" (no second call, same sub-cap); a yes becomes a suggestion
// on the thread card, confirmed with one click. D55: the date the client names, else 3 calendar days after
// their reply. D57: closed when our sent mail carries a Tobira preview link, by the publish hook, or by hand.
// Nothing here runs while calendar_mode = 'off' (ingest has no detection context then; routes are 404).
import { parseFrom, redact, previewDueDate, hasPreviewLink, localToUtc } from '@tobira-inbox/engine';
import { newId } from './store.js';
import { FREE_MAIL } from './ingest.js';

export const DEADLINE_TYPES = ['preview']; // D58: switched-on types
export const DONE_REASONS = ['manual', 'preview_sent', 'published'];

export class DeadlineError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

const domainOf = (addr) => String(addr ?? '').toLowerCase().split('@')[1] ?? '';
const addressesIn = (header) => String(header ?? '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
  .map((p) => parseFrom(p)?.toLowerCase()).filter((a) => a && a.includes('@'));

/**
 * A preview request found by the date call (D54) → one deadline per (mailbox, Gmail thread, type).
 * Only mail from them; a thread that already has one (open, done or dismissed) keeps it, so a dismissal
 * sticks and a later "still keen" mail does not add a second. → the row, or null when nothing was stored.
 */
export function recordPreviewDeadline(db, { mailbox, msg, prep, preview, businessTz, now = new Date() }) {
  if (!preview || prep.direction !== 'theirs' || !DEADLINE_TYPES.includes('preview')) return null;
  const { due, source } = previewDueDate(preview, { sentAt: prep.sentAt, businessTz });
  const thread = db.prepare('SELECT id FROM threads WHERE mailbox_id = ? AND gmail_thread_id = ?').get(mailbox.id, msg.threadId);
  const address = parseFrom(msg.from)?.toLowerCase() ?? null;
  const r = db.prepare(`INSERT INTO deadlines (id, business_id, type, mailbox_id, thread_id, gmail_thread_id, gmail_message_id, client_label, client_address,
      due_date, source, quote_redacted, state, message_at, created_at)
    VALUES (?, ?, 'preview', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT (business_id, mailbox_id, gmail_thread_id, type) DO NOTHING`)
    .run(newId(), mailbox.business_id, mailbox.id, thread?.id ?? null, msg.threadId, msg.id, prep.counterpart, address && address.includes('@') ? address : null,
      due, source, preview.quote ? redact(preview.quote).slice(0, 120) : null, prep.sentAt, now.toISOString());
  if (!r.changes) return null;
  return db.prepare('SELECT * FROM deadlines WHERE business_id = ? AND mailbox_id = ? AND gmail_thread_id = ? AND type = ?').get(mailbox.business_id, mailbox.id, msg.threadId, 'preview');
}

/** A thread row now exists for this Gmail thread: deadlines made before it link to it. */
export function linkDeadlines(db, { mailboxId, gmailThreadId, threadId }) {
  return db.prepare('UPDATE deadlines SET thread_id = ? WHERE mailbox_id = ? AND gmail_thread_id = ? AND thread_id IS NULL').run(threadId, mailboxId, gmailThreadId).changes;
}

function close(db, ids, reason, { userId = null, now = new Date() } = {}) {
  const st = db.prepare("UPDATE deadlines SET state = 'done', done_reason = ?, closed_at = ?, closed_by_user_id = ? WHERE id = ? AND state = 'open'");
  return ids.filter((id) => st.run(reason, now.toISOString(), userId, id).changes > 0);
}

/**
 * D57: one of our sent messages carries a Tobira preview link → open preview deadlines of that thread, or of
 * the recipients' addresses, or of their domain (unless it is shared webmail), close as 'preview_sent'.
 * Suggestions not yet confirmed close too, so the card does not ask about a preview already sent.
 * → ids closed
 */
export function closeOnPreviewLink(db, { mailbox, msg, text, now = new Date() }) {
  if (!hasPreviewLink(text)) return [];
  const to = [...addressesIn(msg.to), ...addressesIn(msg.cc)];
  const domains = [...new Set(to.map(domainOf).filter((d) => d && !FREE_MAIL.has(d)))];
  const rows = db.prepare("SELECT id, mailbox_id, gmail_thread_id, client_address FROM deadlines WHERE business_id = ? AND type = 'preview' AND state = 'open'").all(mailbox.business_id);
  const hit = rows.filter((d) => (d.mailbox_id === mailbox.id && d.gmail_thread_id === msg.threadId)
    || (d.client_address && (to.includes(d.client_address) || domains.includes(domainOf(d.client_address)))));
  return close(db, hit.map((d) => d.id), 'preview_sent', { now });
}

/**
 * The publish hook (POST /admin/businesses/:id/deadlines/close): `threadId` (our thread id or a Gmail thread
 * id) or `client` (an address, a domain, the client label, or the preview slug, e.g. "kikuna" for
 * example.com/kikuna-preview/, matched against the label and the address's domain). Open ones only.
 * → ids closed
 */
export function closeForClient(db, { businessId, client, threadId, reason = 'published', now = new Date() }) {
  if (!DONE_REASONS.includes(reason)) throw new DeadlineError('bad_reason', `reason must be one of ${DONE_REASONS.join(', ')}`);
  const rows = db.prepare("SELECT * FROM deadlines WHERE business_id = ? AND state = 'open'").all(businessId);
  let hit;
  if (threadId) {
    const t = String(threadId);
    hit = rows.filter((d) => d.thread_id === t || d.gmail_thread_id === t);
  } else {
    const c = String(client ?? '').trim().toLowerCase().replace(/-preview\/?$/, '');
    if (c.length < 3) throw new DeadlineError('bad_client', 'client must be an address, domain, label or preview slug (3+ characters)');
    const slug = c.replace(/[^a-z0-9]+/g, '');
    hit = rows.filter((d) => {
      const addr = d.client_address ?? ''; const dom = domainOf(addr); const label = String(d.client_label ?? '').toLowerCase();
      if (c.includes('@')) return addr === c;
      if (c.includes('.')) return !FREE_MAIL.has(dom) && (dom === c || dom.endsWith(`.${c}`)); // never all of gmail.com
      if (label === c) return true;
      // Slug: a whole part of a non-webmail domain ("kikuna" in kikuna-jam.example), its first label without
      // hyphens ("kikuna-jam" → kikunajam.jp or kikuna-jam.example), or the label in Latin letters.
      const parts = FREE_MAIL.has(dom) ? [] : dom.split(/[.-]/);
      const first = FREE_MAIL.has(dom) ? '' : (dom.split('.')[0] ?? '').replace(/[^a-z0-9]/g, '');
      return slug.length >= 3 && (parts.includes(slug) || first === slug || label.replace(/[^a-z0-9]+/g, '') === slug);
    });
  }
  return close(db, hit.map((d) => d.id), reason, { now });
}

/** One deadline of a business, or a DeadlineError. */
function row(db, businessId, id) {
  const d = db.prepare('SELECT * FROM deadlines WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!d) throw new DeadlineError('not_found');
  return d;
}

/** D54: the one click on the thread card. Idempotent. */
export function confirmDeadline(db, { businessId, id, userId = null, now = new Date() }) {
  const d = row(db, businessId, id);
  if (d.state !== 'open') throw new DeadlineError('not_open', `deadline is ${d.state}`);
  if (!d.confirmed_at) db.prepare('UPDATE deadlines SET confirmed_at = ?, confirmed_by_user_id = ? WHERE id = ?').run(now.toISOString(), userId, id);
  return row(db, businessId, id);
}

export function dismissDeadline(db, { businessId, id, userId = null, now = new Date() }) {
  const d = row(db, businessId, id);
  if (d.state === 'dismissed') return d;
  if (d.state !== 'open') throw new DeadlineError('not_open', `deadline is ${d.state}`);
  db.prepare("UPDATE deadlines SET state = 'dismissed', closed_at = ?, closed_by_user_id = ? WHERE id = ?").run(now.toISOString(), userId, id);
  return row(db, businessId, id);
}

/** 完了 in the popover or the card (done_reason 'manual'). Idempotent. */
export function completeDeadline(db, { businessId, id, userId = null, now = new Date() }) {
  const d = row(db, businessId, id);
  if (d.state === 'done') return d;
  if (d.state !== 'open') throw new DeadlineError('not_open', `deadline is ${d.state}`);
  close(db, [id], 'manual', { userId, now });
  return row(db, businessId, id);
}

/** All-day span of a due date in the business zone, as UTC instants (what the grid lays out). */
export function dueSpan(due, tz) {
  const start = localToUtc(`${due}T00:00`, tz);
  const [y, m, d] = due.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start, end: localToUtc(`${next}T00:00`, tz) };
}

/** JSON for the console and the Manager. */
export function deadlineView(d, tz, today) {
  const span = dueSpan(d.due_date, tz);
  return {
    id: d.id, type: d.type, mailboxId: d.mailbox_id, threadId: d.thread_id, gmailThreadId: d.gmail_thread_id, client: d.client_label ?? '',
    due: d.due_date, source: d.source, state: d.state, doneReason: d.done_reason, confirmed: Boolean(d.confirmed_at), quote: d.quote_redacted ?? null,
    overdue: d.state === 'open' && today != null && d.due_date < today, start: span.start, end: span.end,
  };
}

/** Today's date in the business zone (YYYY-MM-DD). */
export function todayIn(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Confirmed, open deadlines due on or before `toDate` (overdue ones stay on the board until closed). */
export function openDeadlines(db, businessId, { toDate = '9999-12-31', fromDate = '0000-01-01', includeOverdue = true } = {}) {
  return db.prepare(`SELECT * FROM deadlines WHERE business_id = ? AND state = 'open' AND confirmed_at IS NOT NULL AND due_date <= ?
      AND (? OR due_date >= ?) ORDER BY due_date, created_at`).all(businessId, toDate, includeOverdue ? 1 : 0, fromDate);
}

/** The thread card's deadline (suggested or confirmed, open only), or null. */
export function threadDeadline(db, { business, thread }) {
  const d = db.prepare(`SELECT * FROM deadlines WHERE business_id = ? AND state = 'open' AND (thread_id = ? OR (mailbox_id = ? AND gmail_thread_id = ?))
      ORDER BY created_at DESC LIMIT 1`).get(business.id, thread.id, thread.mailbox_id, thread.gmail_thread_id);
  const tz = business.timezone || 'Asia/Tokyo';
  return d ? deadlineView(d, tz, todayIn(tz)) : null;
}
