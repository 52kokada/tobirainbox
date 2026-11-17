// apps/server/src/drafting.js — write an AI draft for a sorted thread (D4, D14,
// D21, D23, D24, D32). Drafts are stored for review; they never go into Gmail and
// never send. Shares the per-business daily AI cap with sorting.
import { draftReply, effectiveLabels, parseFrom } from '@tobira-inbox/engine';
import { Store } from './store.js';
import { parseMessage } from './gmail.js';
import { underDailyCap } from './ingest-cap.js';
import { raiseAlert } from './alerts.js';
import { closeIfAnswered } from './answered.js';

function shouldEscalate(text) {
  const t = String(text ?? '');
  return t.length > 1500 || (t.match(/[?？]/g) ?? []).length >= 3;
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db
 * @param {object} o.mailbox   mailboxes row
 * @param {object} o.gmail     Gmail client (getThread)
 * @param {{complete:Function}} o.ai
 * @param {string} o.threadId  our threads.id
 * @param {object} o.msg       parsed latest inbound message
 * @param {boolean} [o.force]  draft even when the label is not set to auto-draft (on request)
 * @returns {Promise<{status:'drafted'|'skipped', reason?:string, draftId?:string}>}
 */
export async function draftForThread({ db, mailbox, gmail, ai, threadId, msg, config = {}, force = false, instruction, current, onText, note }) {
  const store = new Store(db, mailbox.business_id);
  const thread = store.thread(threadId);
  if (!thread) return { status: 'skipped', reason: 'no thread' };
  const label = store.labels().find((l) => l.key === thread.label_key);
  if (!force && !label?.autoDraft) return { status: 'skipped', reason: 'label not auto-draft' };
  // D32: one voice per mailbox, unless the company chose one shared voice for all.
  const voiceId = store.business()?.shared_voice_id ?? mailbox.voice_profile_id;
  const voice = voiceId
    ? db.prepare('SELECT * FROM voice_profiles WHERE id = ? AND business_id = ?').get(voiceId, mailbox.business_id)
    : null;
  if (!voice) return { status: 'skipped', reason: 'no voice for mailbox' };
  const already = db.prepare('SELECT 1 FROM drafts WHERE thread_id = ? AND for_message_id = ?').get(threadId, msg.id);
  if (already) return { status: 'skipped', reason: 'already drafted' };
  if (!underDailyCap(db, mailbox.business_id, config.aiDailyCapUsd)) return { status: 'skipped', reason: 'daily cap' };

  const raw = await gmail.getThread(thread.gmail_thread_id);
  if (!force && closeIfAnswered(db, thread, raw.messages)) return { status: 'skipped', reason: 'answered or a teammate owns it' };
  const own = mailbox.address.toLowerCase();
  const thr = (raw.messages ?? []).map(parseMessage).filter((m) => m.id !== msg.id && !m.reaction).map((m) => ({
    at: m.internalDate, body: m.body, fromUs: m.from.toLowerCase().includes(own), files: (m.attachments ?? []).map((a) => a.filename).filter(Boolean),
  }));
  const examples = db.prepare('SELECT incoming_redacted AS incoming, reply_redacted AS reply FROM examples WHERE business_id = ? AND (label_key = ? OR label_key IS NULL) ORDER BY created_at DESC LIMIT 3')
    .all(mailbox.business_id, thread.label_key);

  const d = await draftReply({
    ai: {
      complete: async (req) => {
        const r = await ai.complete({ ...req, onText, meter: { businessId: mailbox.business_id, mailboxId: mailbox.id, threadId } });
        if (!r.metered) store.logUsage({ operation: req.operation, model: r.model ?? req.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd ?? 0, mailboxId: mailbox.id, threadId });
        return r;
      },
    },
    business: { name: store.business()?.name },
    voice: { fullName: voice.full_name, style: voice.style, signature: voice.signature },
    playbook: store.playbook(thread.label_key),
    facts: store.facts(),
    examples,
    thread: thr,
    latest: msg,
    label: label ? `${label.key}（${label.ja}）` : thread.label_key,
    escalate: shouldEscalate(msg.body),
    instruction,
    current,
  });
  const draftId = store.saveDraft({ threadId, bodyText: d.body, blanks: d.blanks, model: d.model, createdBy: 'ai', note: note ?? instruction ?? null });
  db.prepare('UPDATE drafts SET for_message_id = ? WHERE id = ?').run(msg.id, draftId);
  return { status: 'drafted', draftId };
}

// ── Retries (a failed draft is retried until clean) ──
export const MAX_DRAFT_ATTEMPTS = 5;
const backoffMs = (attempts) => Math.min(60, 2 ** attempts) * 60_000; // 2, 4, 8, 16, 32 min

/** Draft once, recording the attempt; failures stay pending and are retried by retryPendingDrafts. */
export async function draftWithRetry(o) {
  const { db, mailbox, threadId, msg } = o;
  db.prepare("INSERT OR IGNORE INTO draft_attempts (thread_id, message_id, business_id) VALUES (?, ?, ?)").run(threadId, msg.id, mailbox.business_id);
  try {
    const r = await draftForThread(o);
    if (r.status === 'drafted' || r.reason === 'already drafted') {
      db.prepare("UPDATE draft_attempts SET status = 'drafted', last_at = ?, last_error = NULL WHERE thread_id = ? AND message_id = ?")
        .run(new Date().toISOString(), threadId, msg.id);
    } else if (r.reason === 'label not auto-draft') {
      db.prepare('DELETE FROM draft_attempts WHERE thread_id = ? AND message_id = ?').run(threadId, msg.id);
    }
    // 'daily cap' / 'no voice': stays pending without using up an attempt.
    return r;
  } catch (err) {
    const row = db.prepare('SELECT attempts FROM draft_attempts WHERE thread_id = ? AND message_id = ?').get(threadId, msg.id);
    const attempts = (row?.attempts ?? 0) + 1;
    db.prepare('UPDATE draft_attempts SET attempts = ?, status = ?, last_error = ?, last_at = ? WHERE thread_id = ? AND message_id = ?')
      .run(attempts, attempts >= MAX_DRAFT_ATTEMPTS ? 'gave_up' : 'pending', String(err.message).slice(0, 300), new Date().toISOString(), threadId, msg.id);
    if (attempts >= MAX_DRAFT_ATTEMPTS) {
      const t = db.prepare('SELECT cache_subject FROM threads WHERE id = ?').get(threadId);
      raiseAlert(db, { businessId: mailbox.business_id, kind: 'draft_failed', key: threadId, title: `下書きを作れませんでした：${t?.cache_subject ?? ''}`.slice(0, 120),
        body: String(err.message), url: `/#t=${threadId}` });
    }
    throw err;
  }
}

/**
 * Owe a draft → get a draft. Queues every auto-draft thread whose latest message has
 * no draft yet, then retries pending ones whose back-off has passed.
 */
export async function retryPendingDrafts({ db, mailbox, gmail, ai, config = {}, now = new Date() }) {
  const store = new Store(db, mailbox.business_id);
  const auto = new Set(store.labels().filter((l) => l.autoDraft).map((l) => l.key));
  const owed = db.prepare(`SELECT t.id, t.last_message_id, t.label_key FROM threads t
    WHERE t.mailbox_id = ? AND t.status IN ('new','drafted') AND t.last_message_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.thread_id = t.id AND d.for_message_id = t.last_message_id)`).all(mailbox.id);
  const queue = db.prepare('INSERT OR IGNORE INTO draft_attempts (thread_id, message_id, business_id) VALUES (?, ?, ?)');
  for (const t of owed) if (auto.has(t.label_key)) queue.run(t.id, t.last_message_id, mailbox.business_id);

  const due = db.prepare(`SELECT a.* FROM draft_attempts a JOIN threads t ON t.id = a.thread_id
    WHERE t.mailbox_id = ? AND a.status = 'pending'`).all(mailbox.id)
    .filter((a) => !a.last_at || now - new Date(a.last_at) >= backoffMs(a.attempts));
  const out = { retried: 0, drafted: 0, failed: 0 };
  for (const a of due) {
    out.retried += 1;
    try {
      const msg = parseMessage(await gmail.getMessage(a.message_id));
      const r = await draftWithRetry({ db, mailbox, gmail, ai, threadId: a.thread_id, msg, config });
      if (r.status === 'drafted') out.drafted += 1;
      if (r.reason === 'daily cap') break;
    } catch { out.failed += 1; }
  }
  return out;
}

/**
 * A draft on request for the thread's latest inbound message, with an instruction (calendar steps 12-13:
 * free slots, confirmations, corrections). Same steps as POST /api/threads/:id/draft: the open draft is
 * discarded and the message may be drafted again. → draftWithRetry's result, or skipped 'no inbound message'.
 */
export async function draftOnRequest({ db, mailbox, gmail, ai, thread, config = {}, instruction }) {
  const raw = await gmail.getThread(thread.gmail_thread_id);
  const own = mailbox.address.toLowerCase();
  const msgs = (raw.messages ?? []).map(parseMessage).filter((m) => !m.reaction);
  const last = [...msgs].reverse().find((m) => !m.from.toLowerCase().includes(own)) ?? null;
  if (!last) return { status: 'skipped', reason: 'no inbound message' };
  const current = db.prepare("SELECT body_text FROM drafts WHERE thread_id = ? AND status = 'open' ORDER BY version DESC LIMIT 1").get(thread.id)?.body_text ?? '';
  db.prepare("UPDATE drafts SET status = 'discarded' WHERE thread_id = ? AND status = 'open'").run(thread.id);
  db.prepare('UPDATE drafts SET for_message_id = NULL WHERE thread_id = ? AND for_message_id = ?').run(thread.id, last.id);
  db.prepare('DELETE FROM draft_attempts WHERE thread_id = ? AND message_id = ?').run(thread.id, last.id);
  return draftWithRetry({ db, mailbox, gmail, ai, threadId: thread.id, msg: last, config, force: true, instruction, current });
}

// Follow-up when we wrote last and the lead went quiet. The one place this instruction
// lives; the prompt caps instructions at 300 characters.
export const FOLLOWUP_INSTRUCTION = 'The latest message is OUR last email and they have not replied. Write a new short, polite follow-up (no CURRENT DRAFT to rewrite) that refers to that email and proposes one concrete next step: the free sample, or a 30-minute call using the meeting link from PLAYBOOK/FACTS.';

/**
 * A follow-up draft for a thread where our side wrote last. Same drafter, voice, playbook and grounding as
 * every reply; saved for review like any draft (never sent here). → draftForThread's result, or
 * skipped 'they wrote last' when the latest real message is the customer's.
 */
export async function draftFollowup({ db, mailbox, gmail, ai, thread, config = {}, isOwn, onText }) {
  const raw = await gmail.getThread(thread.gmail_thread_id);
  const msgs = (raw.messages ?? []).map(parseMessage).filter((m) => !m.reaction && !(m.labelIds ?? []).includes('DRAFT'));
  const last = msgs.at(-1);
  if (!last) return { status: 'skipped', reason: 'no messages' };
  const ours = (last.labelIds ?? []).includes('SENT') || isOwn(parseFrom(last.from));
  if (!ours) return { status: 'skipped', reason: 'they wrote last' };
  db.prepare("UPDATE drafts SET status = 'discarded' WHERE thread_id = ? AND status = 'open'").run(thread.id);
  db.prepare('UPDATE drafts SET for_message_id = NULL WHERE thread_id = ? AND for_message_id = ?').run(thread.id, last.id);
  return draftForThread({ db, mailbox, gmail, ai, threadId: thread.id, msg: last, config, force: true, instruction: FOLLOWUP_INSTRUCTION, current: '', onText, note: 'フォローアップ' });
}
