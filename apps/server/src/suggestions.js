// apps/server/src/suggestions.js — dates found in mail become suggestions (calendar plan step 9, §5).
// D3: invites are trusted (source 'invite'); AI-found times stay 'suggested' until a person acts.
// D36: every thread, incoming and sent. D42: deterministic pre-filter first, the model only when it
// passes, and only under the date sub-cap (a share of the daily AI cap, checked after sorting).
// D35: the sender-stated zone, else the business zone. Nothing here runs while calendar_mode = 'off'.
// No body text is stored: a redacted quote of at most 120 chars and a counterpart label without address.
import {
  hasDateHints, findCalendarParts, parseIcs, buildDateRequest, parseDateResult, resolveDates,
  stripQuotedContent, parseFrom, isBulkMail, isAutoReply, redact, hasPreviewHints, parsePreviewResult,
} from '@tobira-inbox/engine';
import { recordPreviewDeadline } from './deadlines.js';
import { dailyCap, underDailyCap } from './ingest-cap.js';
import { newId } from './store.js';
import { holdTitle } from './calendar.js';
import { placeHold, releaseHold, holdTarget, handEdited } from './calendar-writes.js';

// Proposed until eval:dates on the test split picks the cheapest model/effort that meets D48 (§5).
export const DATE_MODEL = 'claude-haiku-5-5';
export const DATE_EFFORT = 'low';
export const DATE_SUBCAP_SHARE = 0.3; // D42
export const DATE_OPERATION = 'dates';

/** Business calendar facts detection needs, or null when calendar_mode is 'off' (nothing runs). */
export function detectionContext(db, businessId) {
  const b = db.prepare('SELECT calendar_mode, timezone FROM businesses WHERE id = ?').get(businessId);
  if (!b || b.calendar_mode === 'off') return null;
  return { mode: b.calendar_mode, businessTz: b.timezone || 'Asia/Tokyo' };
}

/** Today's (UTC) spend on date detection for a business. */
export function dateSpendToday(db, businessId) {
  return db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ai_usage WHERE business_id = ? AND operation = ?
    AND at >= strftime('%Y-%m-%dT00:00:00Z','now')`).get(businessId, DATE_OPERATION).s;
}

/**
 * True while a date model call is allowed: date spend today is below 0.3 x the business's daily cap, and
 * the whole cap is not used up (sorting has priority; date detection never pushes total spend over it).
 * A cap of 0 means no cap, as for sorting.
 */
export function underDateSubCap(db, businessId, defaultCap) {
  const cap = dailyCap(db, businessId, defaultCap);
  if (!(cap > 0)) return true;
  return underDailyCap(db, businessId, defaultCap) && dateSpendToday(db, businessId) < DATE_SUBCAP_SHARE * cap;
}

const ADDRESS_RE = /[^\s<>"'@]*@[^\s<>"']*/g;

function firstAddress(header, skip) {
  for (const part of String(header ?? '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const addr = parseFrom(part);
    if (addr && addr.includes('@') && !skip(addr)) return part.trim();
  }
  return null;
}

/**
 * Who the meeting is with, for the "仮: <client>" title (D7): the other party's display name, else their
 * domain. Never an address; at most 40 chars. For our own mail the other party is the first recipient that
 * is not one of us.
 */
export function counterpartLabel(msg, direction, isOwn = () => false) {
  const raw = direction === 'ours' ? (firstAddress(msg.to, isOwn) ?? firstAddress(msg.cc, isOwn)) : msg.from;
  if (!raw) return null;
  const addr = parseFrom(raw);
  const name = String(raw).replace(/<[^>]*>/g, '').replace(/^\s*"|"\s*$/g, '').replace(/\\"/g, '"').trim();
  let label = name && !name.includes('@') ? name : (addr.split('@')[1] ?? '');
  label = redact(label).replace(ADDRESS_RE, '').replace(/@/g, '').replace(/\s+/g, ' ').trim();
  return label ? label.slice(0, 40) : null;
}

/**
 * The cheap part of detection for one parsed message, run before ingest's early `continue`s so own and
 * sent mail is seen. Reactions, spam, bulk and auto-reply mail are skipped (null). Never calls a model.
 * previewHint (D54): mail from them that may ask for a preview also gets the model call (same call, same sub-cap).
 * → { direction, parts, text, hint, previewHint, sentAt, counterpart } | null
 */
export function prepareDetection(msg, payload, { isOwn = () => false } = {}) {
  if (msg.reaction || msg.labelIds.includes('SPAM') || isBulkMail(msg) || isAutoReply(msg)) return null;
  const direction = msg.labelIds.includes('SENT') || isOwn(parseFrom(msg.from)) ? 'ours' : 'theirs';
  const parts = findCalendarParts(payload);
  const text = stripQuotedContent(msg.body ?? '');
  return {
    direction, parts, text, hint: hasDateHints(text, parts), previewHint: direction === 'theirs' && hasPreviewHints(text),
    sentAt: msg.internalDate ?? new Date().toISOString(), counterpart: counterpartLabel(msg, direction, isOwn),
  };
}

/** Invite parts → resolved dates, parsed directly (no model, D3). Attachment bodies are fetched once. */
export async function inviteDates(prep, { businessTz, fetchAttachment, messageId }) {
  const events = [];
  for (const p of prep.parts) {
    let text = p.text;
    if (!text && p.attachmentId && fetchAttachment) {
      try { text = await fetchAttachment(messageId, p.attachmentId); } catch { text = null; }
    }
    if (text) events.push(...parseIcs(text, { fallbackTz: businessTz }).events);
  }
  const seen = new Set();
  return events.filter((e) => { const k = `${e.uid}|${e.startUtc}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((e) => ({ startUtc: e.startUtc, endUtc: e.endUtc, tz: e.tz, tzSource: 'stated', kind: e.kind, quote: e.summary ?? '' }));
}

/** Shadow mode only (§5): every pre-filter decision and model result, no body. */
export function logDetection(db, ctx, { businessId, messageId, hint, model = null, cost = 0, result = null }) {
  if (ctx?.mode !== 'shadow') return;
  db.prepare('INSERT INTO date_detections (business_id, gmail_message_id, prefilter_hit, model, cost_usd, result_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(businessId, messageId, hint ? 1 : 0, model, cost, result == null ? null : JSON.stringify(result));
}

/**
 * The model call for one prepared message (caller has checked the sub-cap). Usage is metered under
 * operation 'dates'. The same reply's "preview" field (D54) becomes a deadline suggestion on the thread.
 * → resolved dates ([] when the reply is not the schema; the error is in the log).
 */
export async function modelDates({ db, ai, ctx, mailbox, msg, prep }) {
  const req = buildDateRequest({ text: prep.text, sentAt: prep.sentAt, businessTz: ctx.businessTz, direction: prep.direction });
  const res = await ai.complete({ ...req, model: DATE_MODEL, effort: DATE_EFFORT, meter: { businessId: mailbox.business_id, mailboxId: mailbox.id } });
  if (!res.metered) {
    db.prepare(`INSERT INTO ai_usage (business_id, mailbox_id, operation, model, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(mailbox.business_id, mailbox.id, DATE_OPERATION, res.model ?? DATE_MODEL, res.tokens_in ?? 0, res.tokens_out ?? 0, res.cost_usd ?? 0);
  }
  let dates = []; let error = null; let preview = null;
  try { dates = resolveDates(parseDateResult(res.text), { businessTz: ctx.businessTz, direction: prep.direction }); } catch (e) { error = e.message; }
  if (!error && prep.direction === 'theirs') {
    try { preview = parsePreviewResult(res.text); } catch { preview = null; }
    if (preview) recordPreviewDeadline(db, { mailbox, msg, prep, preview, businessTz: ctx.businessTz });
  }
  logDetection(db, ctx, { businessId: mailbox.business_id, messageId: msg.id, hint: true, model: res.model ?? DATE_MODEL, cost: res.cost_usd ?? 0,
    result: error ? { error } : preview ? { dates, preview } : dates });
  return dates;
}

/**
 * Store dates found in one message. Upsert by (message, start); thread_id is filled when the Gmail thread
 * has a thread row (§4), else left NULL and linked later by linkSuggestions. Older 'suggested' rows on the
 * same (mailbox, gmail thread) from earlier mail are marked 'superseded'; a row from mail older than the
 * thread's newest suggestion is stored as superseded. Held rows stay held (step 11 releases holds).
 * → the suggestion rows written
 */
export function recordSuggestions(db, { mailbox, msg, prep, source, dates, businessTz, now = new Date() }) {
  if (!dates.length) return [];
  const thread = db.prepare('SELECT id FROM threads WHERE mailbox_id = ? AND gmail_thread_id = ?').get(mailbox.id, msg.threadId);
  const messageAt = prep.sentAt;
  const out = [];
  db.transaction(() => {
    const newer = db.prepare(`SELECT 1 FROM suggestions WHERE mailbox_id = ? AND gmail_thread_id = ? AND gmail_message_id != ? AND message_at > ? LIMIT 1`)
      .get(mailbox.id, msg.threadId, msg.id, messageAt);
    for (const d of dates) {
      const fields = {
        thread_id: thread?.id ?? null, direction: prep.direction, source, end_utc: d.endUtc ?? null,
        stated_tz: d.tzSource === 'stated' ? d.tz : null, business_tz: businessTz,
        quote_redacted: d.quote ? redact(d.quote).slice(0, 120) : null, counterpart_label: prep.counterpart, kind: d.kind, message_at: messageAt,
      };
      const existing = db.prepare('SELECT id FROM suggestions WHERE mailbox_id = ? AND gmail_message_id = ? AND start_utc = ?').get(mailbox.id, msg.id, d.startUtc);
      let id;
      if (existing) {
        id = existing.id;
        db.prepare(`UPDATE suggestions SET thread_id = COALESCE(thread_id, @thread_id), direction = @direction, source = @source, end_utc = @end_utc,
            stated_tz = @stated_tz, business_tz = @business_tz, quote_redacted = @quote_redacted, counterpart_label = @counterpart_label,
            kind = @kind, message_at = @message_at WHERE id = @id`).run({ ...fields, id });
      } else {
        id = newId();
        db.prepare(`INSERT INTO suggestions (id, business_id, mailbox_id, thread_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, end_utc,
            stated_tz, business_tz, quote_redacted, counterpart_label, kind, state, message_at, created_at)
          VALUES (@id, @business_id, @mailbox_id, @thread_id, @gmail_thread_id, @gmail_message_id, @direction, @source, @start_utc, @end_utc,
            @stated_tz, @business_tz, @quote_redacted, @counterpart_label, @kind, @state, @message_at, @created_at)`)
          .run({ ...fields, id, business_id: mailbox.business_id, mailbox_id: mailbox.id, gmail_thread_id: msg.threadId, gmail_message_id: msg.id,
            start_utc: d.startUtc, state: newer ? 'superseded' : 'suggested', created_at: now.toISOString() });
      }
      out.push(db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id));
    }
    if (!newer) {
      db.prepare(`UPDATE suggestions SET state = 'superseded' WHERE mailbox_id = ? AND gmail_thread_id = ? AND gmail_message_id != ?
          AND state = 'suggested' AND (message_at IS NULL OR message_at <= ?)`).run(mailbox.id, msg.threadId, msg.id, messageAt);
    }
  })();
  markPendingChanges(db, out);
  return out;
}

/** The confirmed meeting of a suggestion's thread (by thread row, or by the suggestions its confirm closed), or null. */
export function meetingForThread(db, { business_id, mailbox_id, gmail_thread_id, thread_id }) {
  return db.prepare(`SELECT * FROM meetings WHERE business_id = ? AND mailbox_id = ? AND state = 'confirmed' AND google_event_id IS NOT NULL
      AND ((? IS NOT NULL AND thread_id = ?) OR id IN (SELECT meeting_id FROM suggestions WHERE mailbox_id = ? AND gmail_thread_id = ? AND meeting_id IS NOT NULL))
    ORDER BY start_utc DESC LIMIT 1`).get(business_id, mailbox_id, thread_id ?? null, thread_id ?? null, mailbox_id, gmail_thread_id) ?? null;
}

/**
 * D13: a change or cancel found on a thread whose meeting is confirmed becomes that meeting's pending change
 * (the "変更の提案" badge). Nothing moves in Google until a person applies it.
 */
export function markPendingChanges(db, rows) {
  for (const r of rows) {
    if (!['change', 'cancel'].includes(r.kind) || r.state !== 'suggested') continue;
    const m = meetingForThread(db, r);
    if (m) db.prepare('UPDATE meetings SET pending_change_suggestion_id = ? WHERE id = ?').run(r.id, m.id);
  }
}

/** A thread row now exists for this Gmail thread: suggestions made before it (e.g. from our sent mail) link to it. */
export function linkSuggestions(db, { mailboxId, gmailThreadId, threadId }) {
  return db.prepare('UPDATE suggestions SET thread_id = ? WHERE mailbox_id = ? AND gmail_thread_id = ? AND thread_id IS NULL')
    .run(threadId, mailboxId, gmailThreadId).changes;
}

/** The sub-cap stopped detection for this message: keep its id (no body) for the next-day retry. */
export function deferDetection(db, { mailbox, messageId }) {
  db.prepare('INSERT OR IGNORE INTO date_detection_deferred (mailbox_id, gmail_message_id, business_id) VALUES (?, ?, ?)')
    .run(mailbox.id, messageId, mailbox.business_id);
}

/** Deferred ids of a mailbox from an earlier UTC day (retried "the next day"). */
export function dueDeferred(db, mailboxId, { now = new Date(), limit = 25 } = {}) {
  const today = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
  return db.prepare('SELECT * FROM date_detection_deferred WHERE mailbox_id = ? AND deferred_at < ? AND attempts < 5 ORDER BY deferred_at LIMIT ?')
    .all(mailboxId, today, limit);
}

// ---- holds lifecycle (plan step 11: D4, D7, D20, D23, D25, D26, D28, D43, D46) ----------------------

export class HoldError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

const DAY_MS = 86_400_000;

/** A hold refused before any write (fail closed): recorded for sync health; nothing is placed anywhere. */
function recordRefusal(db, businessId, suggestionId, err) {
  db.prepare(`INSERT INTO calendar_writes (id, business_id, kind, target_id, idem_key, status, attempts, last_error) VALUES (?, ?, 'hold_place', ?, ?, 'failed', 1, ?)
      ON CONFLICT (idem_key) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error, status = 'failed'`)
    .run(newId(), businessId, suggestionId, `hold-refused:${suggestionId}`, `${err.code ?? 'error'}: ${String(err.message).slice(0, 400)}`);
}

/**
 * Put a 仮 hold on the 調整中 calendar for one suggestion (D20, D23, D28), as the D43 owner (calendar-writes
 * fails closed otherwise). Our offers are held by the worker (holdPass); dates offered to us only after a
 * person clicks (POST /api/suggestions/:id/hold). The holds row is made first and reused on retry, so its
 * idem key and Google event id stay the same. → the holds row
 */
export async function holdSuggestion({ db, businessId, suggestionId, clientFor, now = new Date() }) {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ? AND business_id = ?').get(suggestionId, businessId);
  if (!s) throw new HoldError('not_found');
  const existing = db.prepare("SELECT * FROM holds WHERE suggestion_id = ? AND state = 'active'").get(s.id);
  if (s.state === 'held' && existing?.google_event_id) return existing;
  if (s.state !== 'suggested') throw new HoldError('not_open', `suggestion is ${s.state}`);
  if (s.kind === 'cancel') throw new HoldError('not_holdable', 'a cancellation is not held');
  if (Date.parse(s.start_utc) <= now.getTime()) throw new HoldError('past', 'the time has passed');
  try { holdTarget(db, businessId, clientFor); } catch (err) { recordRefusal(db, businessId, s.id, err); throw err; }
  let hold = existing;
  if (!hold) {
    const id = newId();
    db.prepare("INSERT INTO holds (id, business_id, suggestion_id, state, expires_at) VALUES (?, ?, ?, 'active', ?)").run(id, businessId, s.id, s.start_utc);
    hold = db.prepare('SELECT * FROM holds WHERE id = ?').get(id);
  }
  const endUtc = s.end_utc ?? new Date(Date.parse(s.start_utc) + 30 * 60_000).toISOString(); // D38
  await placeHold({ db, businessId, hold, summary: holdTitle(s.counterpart_label), startUtc: s.start_utc, endUtc, clientFor });
  db.prepare("UPDATE suggestions SET state = 'held' WHERE id = ? AND state = 'suggested'").run(s.id);
  return db.prepare('SELECT * FROM holds WHERE id = ?').get(hold.id);
}

/** A person dismisses a suggestion; its active hold, if any, is released (our tagged event only). */
export async function dismissSuggestion({ db, businessId, suggestionId, clientFor }) {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ? AND business_id = ?').get(suggestionId, businessId);
  if (!s) throw new HoldError('not_found');
  if (s.state === 'dismissed') return { state: 'dismissed' };
  for (const h of db.prepare("SELECT * FROM holds WHERE suggestion_id = ? AND state = 'active'").all(s.id)) {
    await releaseHold({ db, businessId, hold: h, clientFor, reason: 'dismiss' });
    db.prepare("UPDATE holds SET state = 'removed' WHERE id = ?").run(h.id);
  }
  db.prepare("UPDATE suggestions SET state = 'dismissed' WHERE id = ?").run(s.id);
  db.prepare('UPDATE meetings SET pending_change_suggestion_id = NULL WHERE pending_change_suggestion_id = ?').run(s.id);
  return { state: 'dismissed' };
}

/** Our own offers (D23: held automatically), still in the future, not held yet. */
export function offersToHold(db, businessId, now = new Date()) {
  return db.prepare(`SELECT * FROM suggestions WHERE business_id = ? AND direction = 'ours' AND kind = 'offer' AND state = 'suggested'
      AND start_utc > ? ORDER BY start_utc LIMIT 50`).all(businessId, now.toISOString());
}

/** Last activity on a suggestion's thread: newest of the thread row's last message and any detected message. */
function lastActivity(db, s) {
  const t = db.prepare('SELECT last_message_at AS t FROM threads WHERE mailbox_id = ? AND gmail_thread_id = ?').get(s.mailbox_id, s.gmail_thread_id)?.t;
  const m = db.prepare('SELECT MAX(message_at) AS m FROM suggestions WHERE mailbox_id = ? AND gmail_thread_id = ?').get(s.mailbox_id, s.gmail_thread_id)?.m;
  const times = [t, m, s.message_at, s.created_at].filter(Boolean).map((x) => Date.parse(x)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/**
 * One worker pass for a business whose calendar_mode is not 'off':
 *  - place holds for our own offers (D23);
 *  - flag holds whose Google event no longer carries our etag (hand edit, D26): flagged, never deleted;
 *  - expire holds whose time has passed or whose thread was silent for hold_silence_days (D25, D46),
 *    deleting only our tagged, unedited event.
 * → { placed, expired, flagged, errors }
 */
export async function holdPass({ db, businessId, clientFor, now = new Date() }) {
  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  const out = { placed: 0, expired: 0, flagged: 0, errors: 0 };
  if (!b || b.calendar_mode === 'off') return out;

  for (const s of offersToHold(db, businessId, now)) {
    try { await holdSuggestion({ db, businessId, suggestionId: s.id, clientFor, now }); out.placed += 1; }
    catch (err) {
      out.errors += 1;
      // Fail closed for the whole business (no owner, no calendar): one recorded refusal per pass is enough.
      if (['no_owner', 'owner_unavailable', 'no_hold_calendar', 'calendar_off'].includes(err.code)) break;
    }
  }

  const silenceMs = (b.hold_silence_days ?? 7) * DAY_MS;
  for (const h of db.prepare("SELECT * FROM holds WHERE business_id = ? AND state = 'active'").all(businessId)) {
    const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(h.suggestion_id);
    const flag = (reason) => { db.prepare("UPDATE holds SET state = 'flagged', flagged_reason = ? WHERE id = ?").run(reason, h.id); out.flagged += 1; };
    // A hand edit as seen by the read sync (calendar_events caches the hold calendar, step 6).
    if (h.google_event_id) {
      const cached = db.prepare('SELECT etag FROM calendar_events WHERE business_id = ? AND google_calendar_id = ? AND google_event_id = ?')
        .get(businessId, h.google_calendar_id, h.google_event_id);
      if (cached && handEdited(h, cached)) { flag('edited in Google'); continue; }
    }
    const last = lastActivity(db, s);
    const expiresAt = Math.min(Date.parse(s.start_utc), last == null ? Infinity : last + silenceMs);
    db.prepare('UPDATE holds SET expires_at = ? WHERE id = ?').run(new Date(expiresAt).toISOString(), h.id);
    if (expiresAt > now.getTime()) continue;
    try {
      await releaseHold({ db, businessId, hold: h, clientFor, reason: 'expire' });
      db.prepare("UPDATE holds SET state = 'expired' WHERE id = ?").run(h.id);
      out.expired += 1;
    } catch (err) {
      if (err.code === 'hand_edited') flag('edited in Google'); else out.errors += 1;
    }
  }
  return out;
}

/** holdPass for every business whose calendar_mode is not 'off'; one failing business never stops the others. */
export async function holdPassAll({ db, clientFor, now = new Date(), log = console }) {
  const out = [];
  for (const { id } of db.prepare("SELECT id FROM businesses WHERE calendar_mode != 'off'").all()) {
    try { out.push({ businessId: id, ...(await holdPass({ db, businessId: id, clientFor, now })) }); }
    catch (err) { log.error?.(`hold pass ${id}: ${err.message}`); out.push({ businessId: id, error: err.message }); }
  }
  return out;
}
