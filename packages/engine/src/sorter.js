// packages/engine/src/sorter.js
// Sort one incoming email into a business label (D1, D7). Deterministic checks
// first; the model only sees the sender's own new text.
import { stripQuotedContent } from './outreach-classifier.js';
import { isAutoReply, isBulkMail } from './auto-reply.js';

export const SORT_MODEL = 'claude-haiku-5-5';
export const UNCONFIRMED = 'unconfirmed';
export const MIN_CONFIDENCE = 0.6;

function buildSortPrompt({ labels, msg, businessName, corrections = [] }) {
  const visible = labels.filter((l) => !l.hidden);
  const body = stripQuotedContent(msg.body ?? '');
  const text = body.length > 2000 ? body.slice(0, 2000) : body;
  return [
    `You sort incoming email for a small business${businessName ? ` (${businessName})` : ''}.`,
    'Pick exactly ONE label key for the message below. Quoted earlier messages have been removed.',
    'Labels:',
    ...visible.map((l) => `  ${l.key} — ${l.ja} / ${l.en}: ${l.hint || ''}`),
    'If the sender asks to stop receiving email, answer optout even if they also decline.',
    ...(corrections.length ? [
      'Past decisions by this business (a person corrected the label; follow the same judgement for similar mail):',
      ...corrections.map((c) => `  - From ${c.fromDomain || '?'} / "${c.subject}" / "${c.excerpt}" → ${c.label}`),
    ] : []),
    'Answer with JSON only: {"label":"<key>","confidence":<0..1>}',
    '',
    `From: ${msg.from ?? ''}`,
    `Subject: ${msg.subject ?? ''}`,
    '--- MESSAGE ---',
    text,
    '---------------',
  ].join('\n');
}

/**
 * @param {object} opts
 * @param {{from?:string, subject?:string, body?:string, autoSubmitted?:string, autoReply?:string, precedence?:string, listUnsubscribe?:string, listId?:string}} opts.msg
 * @param {Array<{key:string, ja:string, en:string, hint?:string, hidden?:boolean}>} opts.labels
 * @param {{complete:Function}} opts.ai  - complete({operation,prompt,model,maxTokens}) → {text}
 * @param {string} [opts.businessName]
 * @returns {Promise<{label:string, confidence:number, by:'rule'|'gmail'|'model'|'low_confidence'|'fallback'|'budget', guess?:string}>}
 */
const NON_PRIMARY = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];

/** The Gmail tab a message landed in, when it is not Primary. */
export function gmailCategory(msg) {
  return (msg?.labelIds ?? []).find((l) => NON_PRIMARY.includes(l)) ?? null;
}

export async function sortMessage({ msg, labels, ai, businessName, allowModel, corrections = [] }) {
  const keys = new Set(labels.filter((l) => !l.hidden).map((l) => l.key));
  keys.add(UNCONFIRMED); // always available, even if a business hides it
  if (isAutoReply(msg) && keys.has('auto_reply')) return { label: 'auto_reply', confidence: 1, by: 'rule' };
  if (isBulkMail(msg) && keys.has('notice')) return { label: 'notice', confidence: 0.9, by: 'rule' };
  // Gmail already sorted it into a non-Primary tab: trust that, no model call.
  if (gmailCategory(msg) && keys.has('notice')) return { label: 'notice', confidence: 0.85, by: 'gmail' };
  if ((msg.labelIds ?? []).includes('SPAM') && keys.has('spam')) return { label: 'spam', confidence: 1, by: 'gmail' };
  // Spending cap reached: no model call, park it as 要確認 for a person.
  if (allowModel && !(await allowModel())) {
    return { label: UNCONFIRMED, confidence: 0, by: 'budget' };
  }

  const result = await ai.complete({
    operation: 'sort',
    prompt: buildSortPrompt({ labels, msg, businessName, corrections }),
    model: SORT_MODEL,
    maxTokens: 40,
  });
  const parsed = parseSort(result?.text ?? '', keys);
  // Never guess: an unreadable answer or a low-confidence one goes to 要確認 for a person.
  if (!parsed) return { label: UNCONFIRMED, confidence: 0, by: 'fallback' };
  if (parsed.confidence < MIN_CONFIDENCE) return { label: UNCONFIRMED, confidence: parsed.confidence, by: 'low_confidence', guess: parsed.label };
  return { ...parsed, by: 'model' };
}

export function parseSort(text, keys) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (keys.has(j.label)) {
        const c = Number(j.confidence);
        return { label: j.label, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5 };
      }
    } catch { /* fall through */ }
  }
  const bare = String(text).trim().toLowerCase();
  if (keys.has(bare)) return { label: bare, confidence: 0.5 };
  return null;
}
