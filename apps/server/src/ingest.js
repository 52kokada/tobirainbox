// apps/server/src/ingest.js — check one mailbox for new mail, sort it, record
// triage state, mirror the label into Gmail (D1, D7, D9, D15).
// Shadow-safe: reads and labels only; never drafts or sends.
import { sortMessage, parseFrom, isBulkMail, isAutoReply } from '@tobira-inbox/engine';
import { googleClient } from './config.js';
import { Store } from './store.js';
import { decrypt } from './crypto.js';
import { Gmail, GmailError, parseMessage } from './gmail.js';
import { underDailyCap } from './ingest-cap.js';
import { draftWithRetry, retryPendingDrafts } from './drafting.js';
import { emit } from './cockpit-outbox.js';
import { raiseAlert, resolveAlerts } from './alerts.js';
import { closeIfAnswered, teammateOwns } from './answered.js';
import {
  detectionContext, prepareDetection, inviteDates, logDetection, modelDates, recordSuggestions, linkSuggestions,
  underDateSubCap, deferDetection, dueDeferred,
} from './suggestions.js';
import { closeOnPreviewLink, linkDeadlines } from './deadlines.js';

export { underDailyCap };

export const LABEL_PREFIX = 'TobirAInbox';
const CACHE_DAYS = 7;
const SEED_DAYS = 7;
const SPAM_EVERY_MIN = 10;

/** Intake rules (D1): everything in unless excluded. */
export function intakeDecision(msg, rules) {
  const from = parseFrom(msg.from);
  const domain = from.split('@')[1] ?? '';
  const only = rules.filter((r) => r.kind === 'include_only_gmail_label');
  if (only.length && !only.some((r) => msg.labelIds.includes(r.value))) return 'excluded';
  for (const r of rules) {
    const v = String(r.value).toLowerCase();
    if (r.kind === 'exclude_sender' && from === v) return 'excluded';
    if (r.kind === 'exclude_domain' && (domain === v || domain.endsWith(`.${v}`))) return 'excluded';
    if (r.kind === 'exclude_gmail_label' && msg.labelIds.includes(r.value)) return 'excluded';
  }
  return 'in';
}

// Mail between people at the same business is never a customer email: our connected mailboxes,
// our console users, and anyone on our own domain (not shared webmail domains).
export const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.co.jp', 'yahoo.com', 'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.com', 'icloud.com', 'me.com', 'docomo.ne.jp', 'ezweb.ne.jp', 'softbank.ne.jp', 'i.softbank.jp']);
export function ownMatcher(db, businessId) {
  const addrs = new Set(db.prepare('SELECT LOWER(address) AS a FROM mailboxes').all().map((r) => r.a));
  for (const r of db.prepare('SELECT LOWER(email) AS a FROM users WHERE business_id = ?').all(businessId)) addrs.add(r.a);
  const domains = new Set();
  for (const r of db.prepare('SELECT LOWER(address) AS a FROM mailboxes WHERE business_id = ? UNION SELECT LOWER(email) FROM users WHERE business_id = ?').all(businessId, businessId)) {
    const d = r.a.split('@')[1]; if (d && !FREE_MAIL.has(d)) domains.add(d);
  }
  return (addr) => { const a = String(addr ?? '').toLowerCase(); return addrs.has(a) || domains.has(a.split('@')[1]); };
}

async function ensureLabels(gmail, labels) {
  const existing = new Map((await gmail.labels()).map((l) => [l.name, l.id]));
  const byKey = new Map();
  for (const l of labels.filter((x) => !x.hidden)) {
    const name = `${LABEL_PREFIX}/${l.ja}`;
    let id = existing.get(name);
    if (!id) id = (await gmail.createLabel(name)).id;
    byKey.set(l.key, id);
  }
  return byKey;
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db
 * @param {object} o.mailbox  mailboxes row
 * @param {{complete:Function}} o.ai
 * @param {{clientId:string, clientSecret:string, masterKey:string}} o.config
 * @param {(opts:object)=>Gmail} [o.gmailFactory]  injectable for tests
 */
function gmailForMailbox(mailbox, config, gmailFactory) {
  const gc = googleClient(config, mailbox.oauth_client);
  return (gmailFactory ?? ((o) => new Gmail(o)))({
    clientId: gc.clientId,
    clientSecret: gc.clientSecret,
    refreshToken: decrypt(mailbox.token_enc, config.masterKey),
  });
}

/**
 * The deterministic half of date detection for one message (calendar step 9): invites are parsed and
 * stored now; mail that passes the pre-filter is returned for the model call, which runs after sorting.
 * Never throws into ingest: a detection failure must not stop mail.
 */
async function detectCheap({ db, ctx, mailbox, gmail, msg, payload, isOwn }) {
  try {
    const prep = prepareDetection(msg, payload, { isOwn });
    if (!prep) return null;
    // D57: our mail with a Tobira preview link closes that client's preview deadline (no model call).
    if (prep.direction === 'ours') closeOnPreviewLink(db, { mailbox, msg, text: msg.body ?? '' });
    if (prep.parts.length) {
      const dates = await inviteDates(prep, { businessTz: ctx.businessTz, messageId: msg.id, fetchAttachment: gmail.getAttachmentText?.bind(gmail) });
      logDetection(db, ctx, { businessId: mailbox.business_id, messageId: msg.id, hint: true, result: { invite: dates } });
      recordSuggestions(db, { mailbox, msg, prep, source: 'invite', dates, businessTz: ctx.businessTz });
      return null;
    }
    if (!prep.hint && !prep.previewHint) { logDetection(db, ctx, { businessId: mailbox.business_id, messageId: msg.id, hint: false }); return null; }
    return { msg, prep };
  } catch { return null; }
}

/** The model half, under the date sub-cap; over it, the id is kept for the next-day retry (§5). */
async function detectWithModel({ db, ai, ctx, mailbox, config, item, result }) {
  if (!underDateSubCap(db, mailbox.business_id, config.aiDailyCapUsd)) {
    deferDetection(db, { mailbox, messageId: item.msg.id });
    result.datesDeferred = (result.datesDeferred ?? 0) + 1;
    return false;
  }
  const dates = await modelDates({ db, ai, ctx, mailbox, msg: item.msg, prep: item.prep });
  const rows = recordSuggestions(db, { mailbox, msg: item.msg, prep: item.prep, source: 'ai', dates, businessTz: ctx.businessTz });
  if (rows.length) result.suggestions = (result.suggestions ?? 0) + rows.length;
  return true;
}

export async function ingestMailbox({ db, mailbox, ai, config, gmailFactory, now = () => new Date() }) {
  const store = new Store(db, mailbox.business_id);
  const gmail = gmailForMailbox(mailbox, config, gmailFactory);
  // Calendar date detection (step 9): null while calendar_mode = 'off', and then none of it runs.
  const dateCtx = detectionContext(db, mailbox.business_id);
  const labels = store.labels();
  const rules = db.prepare('SELECT kind, value FROM intake_rules WHERE business_id = ? AND (mailbox_id IS NULL OR mailbox_id = ?)')
    .all(mailbox.business_id, mailbox.id);
  const isOwn = ownMatcher(db, mailbox.business_id);
  // What people at this business corrected recently: the sorter follows the same judgement.
  const corrections = db.prepare(`SELECT from_domain AS fromDomain, subject_redacted AS subject, excerpt_redacted AS excerpt, to_label AS label
    FROM label_corrections WHERE business_id = ? ORDER BY at DESC LIMIT 20`).all(mailbox.business_id);
  const result = { checked: 0, sorted: 0, excluded: 0, own: 0, errors: 0 };

  let ids; let nextHistoryId;
  if (!mailbox.history_id) {
    nextHistoryId = (await gmail.profile()).historyId;
    ids = await gmail.listInbox({ newerThanDays: SEED_DAYS });
  } else {
    try {
      const h = await gmail.historySince(mailbox.history_id);
      ids = h.messageIds; nextHistoryId = h.historyId;
    } catch (err) {
      if (!(err instanceof GmailError && err.status === 404)) throw err;
      nextHistoryId = (await gmail.profile()).historyId; // history id expired: resync recent inbox
      ids = await gmail.listInbox({ newerThanDays: SEED_DAYS });
    }
  }

  // Our own sent mail is read for dates too (D36), only while the calendar is not 'off'. Ids that come only
  // from SENT history go through detection and nothing else, so triage stays exactly as it was.
  const sentOnly = new Set();
  if (dateCtx && mailbox.history_id && gmail.sentHistorySince) {
    try {
      const inInbox = new Set(ids);
      for (const sid of (await gmail.sentHistorySince(mailbox.history_id)).messageIds) if (!inInbox.has(sid)) sentOnly.add(sid);
      ids = [...ids, ...sentOnly];
    } catch { /* sent history is for dates only; never block the inbox */ }
  }
  const pendingDates = [];

  // Spam watch: every SPAM_EVERY_MIN, look at recent spam for customers Gmail filed there by mistake.
  const spamDue = gmail.listSpam && (!mailbox.spam_checked_at || now() - new Date(mailbox.spam_checked_at) > SPAM_EVERY_MIN * 60_000);
  if (spamDue) {
    try { ids = [...ids, ...(await gmail.listSpam({ newerThanDays: 3, max: 25 }))]; } catch { /* spam is a bonus; never block the inbox */ }
    db.prepare('UPDATE mailboxes SET spam_checked_at = ? WHERE id = ?').run(now().toISOString(), mailbox.id);
  }

  const seen = db.prepare('SELECT 1 FROM seen_messages WHERE mailbox_id = ? AND gmail_message_id = ?');
  const markSeen = db.prepare('INSERT OR IGNORE INTO seen_messages (mailbox_id, gmail_message_id, outcome) VALUES (?, ?, ?)');
  let labelIds = null;

  for (const id of ids) {
    if (seen.get(mailbox.id, id)) continue;
    result.checked += 1;
    try {
      const raw = await gmail.getMessage(id);
      const msg = parseMessage(raw);
      // Date detection runs before the early continues below, so own and sent mail is seen (step 9).
      if (dateCtx) {
        const item = await detectCheap({ db, ctx: dateCtx, mailbox, gmail, msg, payload: raw.payload, isOwn });
        if (item) pendingDates.push(item);
      }
      if (sentOnly.has(id)) { markSeen.run(mailbox.id, id, 'own'); continue; }
      if (msg.reaction) { markSeen.run(mailbox.id, id, 'own'); result.own += 1; continue; }
      const fromSpam = msg.labelIds.includes('SPAM');
      // Spam: newsletters, bulk and auto-replies stay there, free (no model call).
      if (fromSpam && (isBulkMail(msg) || isAutoReply(msg) || isOwn(parseFrom(msg.from)))) { markSeen.run(mailbox.id, id, 'skipped'); continue; }
      if ((!msg.labelIds.includes('INBOX') && !fromSpam) || msg.labelIds.includes('SENT') || isOwn(parseFrom(msg.from))) {
        // Someone on our side wrote last in a thread we track: it is answered (or internal), so it leaves 要対応.
        if (msg.labelIds.includes('SENT') || isOwn(parseFrom(msg.from))) {
          db.prepare(`UPDATE threads SET status = 'done', updated_at = ? WHERE mailbox_id = ? AND gmail_thread_id = ? AND status IN ('new', 'drafted')`)
            .run(now().toISOString(), mailbox.id, msg.threadId);
        }
        markSeen.run(mailbox.id, id, 'own'); result.own += 1; continue;
      }
      if (intakeDecision(msg, rules) === 'excluded') {
        markSeen.run(mailbox.id, id, 'excluded'); result.excluded += 1; continue;
      }
      const sorted = await sortMessage({ msg: fromSpam ? { ...msg, labelIds: msg.labelIds.filter((l) => l !== 'SPAM') } : msg, labels, corrections, allowModel: () => underDailyCap(db, mailbox.business_id, config.aiDailyCapUsd), ai: {
        complete: async (req) => {
          const r = await ai.complete({ ...req, meter: { businessId: mailbox.business_id, mailboxId: mailbox.id } });
          if (!r.metered) store.logUsage({ operation: req.operation, model: r.model ?? req.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd ?? 0, mailboxId: mailbox.id });
          return r;
        },
      } });
      // From spam, only real customer mail comes out: the kinds that get a reply, or ones a person must check.
      if (fromSpam && !(labels.find((l) => l.key === sorted.label)?.autoDraft || sorted.label === 'unconfirmed')) {
        markSeen.run(mailbox.id, id, 'skipped'); continue;
      }
      const teammate = teammateOwns(db, mailbox.business_id, mailbox.address, msg);
      const at = now();
      const cacheUntil = new Date(at.getTime() + CACHE_DAYS * 86400_000).toISOString();
      db.transaction(() => {
        db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, last_rfc_message_id,
            label_key, label_confidence, label_by, status, cache_from, cache_subject, cache_snippet, cache_expires_at, last_message_at, updated_at)
          VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (mailbox_id, gmail_thread_id) DO UPDATE SET
            last_message_id = excluded.last_message_id, last_rfc_message_id = excluded.last_rfc_message_id,
            label_key = excluded.label_key, label_confidence = excluded.label_confidence, label_by = excluded.label_by,
            status = CASE WHEN excluded.status = 'done' THEN 'done' WHEN threads.status IN ('sent','done','waiting','ignored') THEN 'new' ELSE threads.status END,
            cache_from = excluded.cache_from, cache_subject = excluded.cache_subject, cache_snippet = excluded.cache_snippet,
            cache_expires_at = excluded.cache_expires_at, last_message_at = excluded.last_message_at, updated_at = excluded.updated_at`)
          .run(mailbox.business_id, mailbox.id, msg.threadId, msg.id, msg.messageId || null,
            sorted.label, sorted.confidence, sorted.by, teammate ? 'done' : 'new', msg.from, msg.subject, msg.snippet.slice(0, 300), cacheUntil,
            msg.internalDate ?? at.toISOString(), at.toISOString());
        markSeen.run(mailbox.id, id, 'sorted');
        const tid = db.prepare('SELECT id FROM threads WHERE mailbox_id = ? AND gmail_thread_id = ?').get(mailbox.id, msg.threadId)?.id;
        if (tid) { linkSuggestions(db, { mailboxId: mailbox.id, gmailThreadId: msg.threadId, threadId: tid }); linkDeadlines(db, { mailboxId: mailbox.id, gmailThreadId: msg.threadId, threadId: tid }); }
        db.prepare('UPDATE threads SET in_spam = ? WHERE mailbox_id = ? AND gmail_thread_id = ?').run(fromSpam ? 1 : 0, mailbox.id, msg.threadId);
        emit(db, { businessId: mailbox.business_id, type: 'sorted', mailbox: mailbox.address, thread: msg.threadId, gmailMessageId: msg.id,
          from: msg.from, label: sorted.label, extra: { labelBy: sorted.by, confidence: sorted.confidence, inReplyTo: msg.inReplyTo || null, references: msg.references || null, messageIdHeader: msg.messageId || null } });
        db.prepare('UPDATE threads SET label_guess = ? WHERE mailbox_id = ? AND gmail_thread_id = ?').run(sorted.guess ?? null, mailbox.id, msg.threadId);
        db.prepare(`INSERT OR REPLACE INTO message_labels (mailbox_id, gmail_message_id, gmail_thread_id, label_key, label_by, confidence)
          VALUES (?, ?, ?, ?, ?, ?)`).run(mailbox.id, msg.id, msg.threadId, sorted.label, sorted.by, sorted.confidence);
      })();
      result.sorted += 1;

      if (mailbox.write_labels) {
        labelIds ??= await ensureLabels(gmail, labels);
        const add = labelIds.get(sorted.label);
        const remove = [...labelIds.values()].filter((x) => x !== add);
        if (add) await gmail.modifyThread(msg.threadId, { add: [add], remove });
      }

      if (config.drafting !== false && !teammate) {
        const row = db.prepare('SELECT id FROM threads WHERE mailbox_id = ? AND gmail_thread_id = ?').get(mailbox.id, msg.threadId);
        try {
          const d = await draftWithRetry({ db, mailbox, gmail, ai, threadId: row.id, msg, config });
          if (d.status === 'drafted') result.drafted = (result.drafted ?? 0) + 1;
        } catch (err) {
          result.draftErrors = (result.draftErrors ?? 0) + 1;
          db.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?').run(`draft ${id}: ${String(err.message).slice(0, 300)}`, mailbox.id);
        }
      }
    } catch (err) {
      result.errors += 1;
      db.prepare('UPDATE mailboxes SET last_error = ? WHERE id = ?').run(`${id}: ${String(err.message).slice(0, 300)}`, mailbox.id);
    }
  }

  // Date model calls run after every message of this pass was sorted and metered (D42: sorting first).
  for (const item of pendingDates) {
    try { await detectWithModel({ db, ai, ctx: dateCtx, mailbox, config, item, result }); }
    catch { result.dateErrors = (result.dateErrors ?? 0) + 1; }
  }

  // Answered elsewhere (Gmail, a teammate's own mailbox, CC): re-check open threads on the spam-watch cadence.
  if (spamDue) {
    for (const t of db.prepare("SELECT * FROM threads WHERE mailbox_id = ? AND status IN ('new','drafted') ORDER BY last_message_at DESC LIMIT 40").all(mailbox.id)) {
      try { const raw = await gmail.getThread(t.gmail_thread_id); if (closeIfAnswered(db, t, raw.messages)) result.answeredElsewhere = (result.answeredElsewhere ?? 0) + 1; } catch { /* next pass */ }
    }
  }

  if (config.drafting !== false) {
    const rr = await retryPendingDrafts({ db, mailbox, gmail, ai, config });
    if (rr.retried) Object.assign(result, { retriedDrafts: rr.retried, retryDrafted: rr.drafted, retryFailed: rr.failed });
  }

  db.prepare(`UPDATE mailboxes SET history_id = ?, last_polled_at = ?, status = 'connected',
      last_error = CASE WHEN ? = 0 THEN NULL ELSE last_error END WHERE id = ?`)
    .run(String(nextHistoryId), now().toISOString(), result.errors, mailbox.id);
  return result;
}

/**
 * Messages whose date model call the sub-cap deferred on an earlier UTC day are fetched again from Gmail
 * (bodies are never stored) and detected now, still under the sub-cap. The worker calls this each pass.
 */
export async function retryDeferredDates({ db, ai, config, gmailFactory, now = () => new Date() }) {
  const out = { retried: 0, failed: 0 };
  const boxes = db.prepare(`SELECT * FROM mailboxes WHERE status = 'connected' AND token_enc IS NOT NULL
    AND id IN (SELECT mailbox_id FROM date_detection_deferred)`).all();
  for (const mailbox of boxes) {
    const ctx = detectionContext(db, mailbox.business_id);
    if (!ctx) continue;
    const due = dueDeferred(db, mailbox.id, { now: now() });
    if (!due.length) continue;
    const gmail = gmailForMailbox(mailbox, config, gmailFactory);
    const isOwn = ownMatcher(db, mailbox.business_id);
    for (const row of due) {
      if (!underDateSubCap(db, mailbox.business_id, config.aiDailyCapUsd)) break;
      try {
        const raw = await gmail.getMessage(row.gmail_message_id);
        const msg = parseMessage(raw);
        const prep = prepareDetection(msg, raw.payload, { isOwn });
        if (prep?.hint && !prep.parts.length) {
          const dates = await modelDates({ db, ai, ctx, mailbox, msg, prep });
          recordSuggestions(db, { mailbox, msg, prep, source: 'ai', dates, businessTz: ctx.businessTz });
        }
        db.prepare('DELETE FROM date_detection_deferred WHERE mailbox_id = ? AND gmail_message_id = ?').run(mailbox.id, row.gmail_message_id);
        out.retried += 1;
      } catch (err) {
        db.prepare('UPDATE date_detection_deferred SET attempts = attempts + 1, last_error = ? WHERE mailbox_id = ? AND gmail_message_id = ?')
          .run(String(err.message).slice(0, 300), mailbox.id, row.gmail_message_id);
        out.failed += 1;
      }
    }
  }
  return out;
}

/** One pass over every connected mailbox; one failing mailbox never stops the others. */
export async function ingestAll({ db, ai, config, gmailFactory, log = console }) {
  const boxes = db.prepare("SELECT * FROM mailboxes WHERE status = 'connected' AND mode != 'paused' AND token_enc IS NOT NULL").all();
  const out = [];
  for (const mailbox of boxes) {
    try {
      const r = await ingestMailbox({ db, mailbox, ai, config, gmailFactory });
      resolveAlerts(db, { businessId: mailbox.business_id, kind: 'mailbox_error', key: mailbox.id });
      out.push({ address: mailbox.address, ...r });
    } catch (err) {
      const status = err instanceof GmailError && (err.status === 401 || err.status === 403) ? 'error' : 'connected';
      if (status === 'error') {
        raiseAlert(db, { businessId: mailbox.business_id, kind: 'mailbox_error', key: mailbox.id, title: `${mailbox.address} の接続が切れました`,
          body: 'Google でアクセスが取り消されたか期限切れです。設定 → メールボックスから接続し直してください。', url: '/#settings' });
      }
      db.prepare('UPDATE mailboxes SET last_error = ?, status = ?, last_polled_at = ? WHERE id = ?')
        .run(String(err.message).slice(0, 500), status, new Date().toISOString(), mailbox.id);
      log.error?.(`ingest ${mailbox.address}: ${err.message}`);
      out.push({ address: mailbox.address, error: err.message });
    }
  }
  return out;
}
