// apps/server/src/learning.js — how TobirAInbox learns (D4, D21, D22, D29).
//  • every reply a person sends becomes an example, contact details removed (D22: automatic)
//  • on request, past sent mail is read once and turned into examples too (D4: history)
//  • from those examples the model proposes new playbook rules; an owner accepts or rejects (D21/D22)
import { redact, assertRedacted, parseFrom, stripQuotedContent } from '@tobira-inbox/engine';
import { newId, Store } from './store.js';
import { parseMessage } from './gmail.js';
import { underDailyCap } from './ingest-cap.js';

const KEEP_PER_LABEL = 40;
export const RULES_MODEL = 'claude-sonnet-5-5';

const displayName = (from) => String(from ?? '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
function keepHosts(db, businessId) {
  const url = db.prepare('SELECT website_url FROM businesses WHERE id = ?').get(businessId)?.website_url;
  try { return url ? [new URL(url).hostname.replace(/^www\./, '')] : []; } catch { return []; }
}

/** Store one redacted example. Returns false when it was skipped (too short, or redaction could not be proven). */
export function saveExample(db, { businessId, mailboxId = null, labelKey = null, incoming, reply, gmailMessageId = null, source = 'sent', names = [] }) {
  const inText = String(stripQuotedContent(incoming ?? '')).trim().slice(0, 3000);
  const outText = String(reply ?? '').trim().slice(0, 3000);
  if (inText.length < 8 || outText.length < 8) return false;
  const hosts = keepHosts(db, businessId);
  const a = redact(inText, { keepHosts: hosts, names }); const b = redact(outText, { keepHosts: hosts, names });
  try { assertRedacted(a); assertRedacted(b); } catch { return false; }
  const r = db.prepare(`INSERT OR IGNORE INTO examples (id, business_id, mailbox_id, label_key, incoming_redacted, reply_redacted, source, gmail_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(newId(), businessId, mailboxId, labelKey, a, b, source, gmailMessageId);
  // Keep the newest examples per label; old ones fall away.
  db.prepare(`DELETE FROM examples WHERE business_id = ? AND COALESCE(label_key, '') = COALESCE(?, '') AND id NOT IN (
      SELECT id FROM examples WHERE business_id = ? AND COALESCE(label_key, '') = COALESCE(?, '') ORDER BY created_at DESC LIMIT ${KEEP_PER_LABEL})`)
    .run(businessId, labelKey, businessId, labelKey);
  return r.changes > 0;
}

/** Called by the send worker after a reply leaves (D22). */
export function learnFromSent(db, { send, thread, mailbox, delivered }) {
  if (!delivered?.incoming) return false;
  return saveExample(db, {
    businessId: mailbox.business_id, mailboxId: mailbox.id, labelKey: thread.label_key,
    incoming: delivered.incoming, reply: send.body_text, gmailMessageId: delivered.messageId ?? null,
    source: 'sent', names: [displayName(delivered.incomingFrom)],
  });
}

/** Read past sent replies from one mailbox and keep them as examples (D4). */
export async function importHistory(db, { mailbox, gmail, maxThreads = 60 }) {
  const own = mailbox.address.toLowerCase();
  let saved = 0; let seen = 0;
  for (const tid of await gmail.listSentThreads({ max: maxThreads })) {
    let raw; try { raw = await gmail.getThread(tid); } catch { continue; }
    const msgs = (raw.messages ?? []).map(parseMessage);
    for (let i = 1; i < msgs.length; i += 1) {
      const m = msgs[i];
      if (parseFrom(m.from) !== own) continue;
      const before = msgs.slice(0, i).reverse().find((x) => parseFrom(x.from) !== own);
      if (!before) continue; // an opening email we wrote, not a reply
      seen += 1;
      const known = db.prepare('SELECT label_key FROM threads WHERE mailbox_id = ? AND gmail_thread_id = ?').get(mailbox.id, tid);
      if (saveExample(db, { businessId: mailbox.business_id, mailboxId: mailbox.id, labelKey: known?.label_key ?? null,
        incoming: before.body, reply: stripQuotedContent(m.body), gmailMessageId: m.id, source: 'history', names: [displayName(before.from)] })) saved += 1;
    }
  }
  return { seen, saved };
}

export function buildRulesPrompt({ business, examples, playbook, labels }) {
  return [
    `You help the owner of ${business ?? 'a small business'} write reply rules for their email assistant.`,
    'Below are real replies they sent (contact details removed) and the rules they already have.',
    'Propose up to 5 NEW rules that describe how this business consistently handles a kind of situation, so future drafts follow it.',
    'Each rule: one plain Japanese sentence an owner would write, e.g. 「予約の変更は、空き状況を確認してから折り返すと伝える。」 Do not copy names, prices, dates or URLs from the examples.',
    'Skip anything already covered by the existing rules. If there is nothing new, write nothing.',
    `Format, one per line: ラベルキー | ルール  (ラベルキー is one of: ${labels.join(', ')}, or * for all mail)`,
    '',
    '## Existing rules',
    playbook.length ? playbook.map((r) => `- ${r.text}`).join('\n') : '(none)',
    '',
    '## Replies they sent',
    ...examples.map((e, i) => `### ${i + 1} (${e.label_key ?? '*'})\nTHEY WROTE:\n${e.incoming_redacted.slice(0, 800)}\nWE REPLIED:\n${e.reply_redacted.slice(0, 800)}`),
  ].join('\n');
}

export function parseRules(text, labels) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.trim().replace(/^(?:[-・]|\d+[.)])\s+/, '').match(/^([a-z0-9_*]+)\s*\|\s*(.{6,240})$/);
    if (!m) continue;
    out.push({ label: m[1] === '*' || !labels.includes(m[1]) ? null : m[1], text: m[2].trim() });
  }
  return out.slice(0, 5);
}

/** Ask the model for new playbook rules; stored as proposals for the owner (D21). */
export async function proposeRules(db, { ai, businessId, config = {} }) {
  const store = new Store(db, businessId);
  const examples = db.prepare('SELECT label_key, incoming_redacted, reply_redacted FROM examples WHERE business_id = ? ORDER BY created_at DESC LIMIT 30').all(businessId);
  if (examples.length < 3) return { proposed: 0, reason: 'not_enough_examples' };
  if (!ai) throw new Error('AI が設定されていません');
  if (!underDailyCap(db, businessId, config.aiDailyCapUsd)) throw new Error('本日の AI 利用上限に達しています');
  const playbook = db.prepare("SELECT text FROM playbook_rules WHERE business_id = ? AND status IN ('active','proposed')").all(businessId);
  const labels = store.labels().filter((l) => !l.hidden && l.key !== 'unconfirmed').map((l) => l.key);
  const res = await ai.complete({ operation: 'rules', prompt: buildRulesPrompt({ business: store.business()?.name, examples, playbook, labels }), model: RULES_MODEL, maxTokens: 4000, meter: { businessId } });
  const have = new Set(db.prepare('SELECT text FROM playbook_rules WHERE business_id = ?').all(businessId).map((r) => r.text));
  let proposed = 0;
  for (const r of parseRules(res?.text, labels)) {
    if (have.has(r.text)) continue;
    db.prepare("INSERT INTO playbook_rules (id, business_id, label_key, text, source, status) VALUES (?, ?, ?, ?, 'ai_proposed', 'proposed')").run(newId(), businessId, r.label, r.text);
    proposed += 1;
  }
  db.prepare('UPDATE businesses SET rules_proposed_at = ? WHERE id = ?').run(new Date().toISOString(), businessId);
  return { proposed };
}

/** Weekly: propose rules for businesses that have gathered at least 5 new examples since last time. */
export async function proposeRulesWeekly(db, { ai, config, now = new Date() }) {
  const due = db.prepare(`SELECT b.id FROM businesses b WHERE b.status = 'active' AND (b.rules_proposed_at IS NULL OR b.rules_proposed_at < ?)
    AND (SELECT COUNT(*) FROM examples e WHERE e.business_id = b.id AND e.created_at > COALESCE(b.rules_proposed_at, '')) >= 5`)
    .all(new Date(now - 7 * 86400_000).toISOString());
  for (const b of due) { try { await proposeRules(db, { ai, businessId: b.id, config }); } catch { /* try again next week */ } }
  return due.length;
}
