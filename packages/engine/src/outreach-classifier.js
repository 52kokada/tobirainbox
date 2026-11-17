// packages/engine/src/outreach-classifier.js
// Reply classifier for outreach replies; originally shared with an optional external CRM backend.
// Cockpit-compatible verdicts for outreach replies; the business label sorter is sorter.js.
// source: external CRM backend, hash-pinned by test/outreach-classifier-sync.test.js sha256:342269f1b18df5914d2acd7dc21ed2a5fb69d7a3754c7299b429b42bde6b304a
// END SYNC HEADER
// Pinned by test/outreach-classifier-corpus.test.js and fixtures/classifier-corpus.json.

// `optout` is checked before `negative` so a model that answers "OPTOUT" is
// never read as a plain decline. Japanese law (特定電子メール法 第4条) requires
// that a request to stop receiving mail is honoured, so it is its own verdict
// rather than a flavour of NEGATIVE (2026-11-05, D74).
const VALID = new Set(['optout', 'positive', 'negative', 'oob', 'auto', 'unclear']);

// Patterns that mark the start of quoted original-email content.
const QUOTE_SEPARATOR_RE = /^(-{3,}|_{3,}|={3,})\s*(original message|元のメッセージ|forwarded message|転送メッセージ)?/i;
const OUTLOOK_SEPARATOR_RE = /^From:\s+.+@/i;
const WROTE_SEPARATOR_RE = /^On .{5,}, .+ wrote:$/i;
// Japanese quote headers. Apple Mail: "2026/06/10 19:10、Alex Mori <a@x>のメール:";
// Gmail: "2026年6月10日(水) 19:10 Alex Mori <a@x>:". Unrecognised, they let
// our own quoted email (and its 今後のご連絡を… footer) reach the model: every
// reply from one prospect was misread that way, one of them as OPTOUT.
const JA_WROTE_SEPARATOR_RE = /^\d{4}[/年]\s*\d{1,2}[/月]\s*\d{1,2}日?.{0,20}?\d{1,2}:\d{2}.*(のメール|<[^>\s]+@[^>\s]+>)\s*[:：]$/;

// Apple Mail's one-click unsubscribe sends this fixed text with auto-reply
// headers (subject "unsubscribe"). It is a stop request (特定電子メール法 第4条),
// not an autoresponder; one such message was filed as out-of-office.
export const APPLE_MAIL_UNSUBSCRIBE_RE = /unsubscribe.{0,6}というメッセージへの登録を解除するためにApple Mailから送信されました|sent from Apple Mail to unsubscribe/i;

// Minimal markup-to-text for bodies stored as HTML (replies binned before
// gmail/receive.js converted HTML, then rematched). Dependency-free because
// tobira-inbox syncs this file as a copy.
function htmlBodyToText(body) {
  if (!/<(html|body|div|p|br)\b[^>]*>/i.test(body)) return body;
  return body
    .replace(/<(head|style|script)\b[^>]*>[\s\S]*?<\/(head|style|script)>/gi, '')
    .replace(/<\/(div|p|li|tr|blockquote)>\s*<(div|p|li|tr|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/?(div|p|li|tr|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/﻿/g, '');
}

/**
 * Remove quoted-original-email lines from a reply body so the classifier
 * only sees the prospect's own new text.
 *
 * Handles the two common patterns:
 *   1. Lines prefixed with `>` or full-width `＞` (RFC 2822 / most clients)
 *   2. Inline-separator blocks ("--- Original Message ---", "On … wrote:", etc.)
 *
 * Falls back to the original body if stripping would leave nothing.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripQuotedContent(body) {
  if (!body) return '';
  body = htmlBodyToText(body);
  const lines = body.split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Standard quote prefix
    if (trimmed.startsWith('>') || trimmed.startsWith('＞')) continue;
    // Separator lines that introduce the original email block
    if (QUOTE_SEPARATOR_RE.test(trimmed)) break;
    if (WROTE_SEPARATOR_RE.test(trimmed)) break;
    if (JA_WROTE_SEPARATOR_RE.test(trimmed)) break;
    // Outlook-style "From: x@y …" header after at least one line of real text
    if (kept.length > 0 && OUTLOOK_SEPARATOR_RE.test(trimmed)) break;
    kept.push(line);
  }
  const result = kept.join('\n').trim();
  // If we stripped everything (edge case: reply is only a quote), use the original.
  return result || body.trim();
}

// Two misreads seen in use, fenced in code as well as in the prompt: a reply that
// asked to see a proposal and to write to another person from now on came back
// OPTOUT, though it asks us to continue; and a reply that asked for no further
// contact and gave a business reason came back UNCLEAR, though it is a plain
// request to stop with a reason attached.
//
// An explicit request to stop contact, matched on the prospect's own text.
export const EXPLICIT_OPTOUT_RE = /(今後|以後|これ以上)[^。\n]{0,12}?(連絡|メール|ご案内|営業)[^。\n]{0,8}?(希望(いた)?しません|不要|お断り|ご遠慮|控えて|しないで|送らないで|停止)|配信を?停止|配信不要|(送信|送付)しないで|送らないでください|リストから(の)?削除|unsubscribe|remove me|stop (emailing|sending|contacting)/i;
// "From now on, write to me / to the address below": a redirect, not a stop.
export const REDIRECT_RE = /(下記|以下|こちら|私|わたくし|わたし|担当者?)[^。\n]{0,8}?(宛|あて)|(下記|以下)の?(メールアドレス|アドレス|連絡先)(まで|に|へ)|(contact|reach|email|write to) me at|please (contact|email|write to|reach) \S+@/i;

/**
 * Correct the model's label where the text settles it without judgement. A
 * redirect with no stop request is never an opt-out; an explicit stop request
 * read as negative or unclear is an opt-out (特定電子メール法 第4条).
 */
// Abuse: never answered, never mailed again (owner decision). Strict words only,
// so a polite decline is never caught.
export const HOSTILE_RE = /ペテン師|詐欺師|ふざけるな|ふざけんな|死ね|くたばれ|バカ野郎|馬鹿野郎|(?<![ァ-ヶー])クソ(?![ァ-ヶー])|(?<![ァ-ヶー])ボケ(?![ァ-ヶー])|\b(?:fuck|scam(?:mer)?s?|idiots?)\b/i;

export function applyTextRules(verdict, body) {
  const text = stripQuotedContent(body ?? '');
  if (APPLE_MAIL_UNSUBSCRIBE_RE.test(text)) return { verdict: 'optout', overridden: verdict !== 'optout' };
  if (HOSTILE_RE.test(text)) return { verdict: 'optout', overridden: verdict !== 'optout' };
  const stops = EXPLICIT_OPTOUT_RE.test(text);
  if (verdict === 'optout' && !stops && REDIRECT_RE.test(text)) return { verdict: 'positive', overridden: true };
  if (stops && (verdict === 'negative' || verdict === 'unclear')) return { verdict: 'optout', overridden: true };
  return { verdict, overridden: false };
}

function buildPrompt(body) {
  const stripped = stripQuotedContent(body);
  const truncated = stripped.length > 1500 ? stripped.slice(0, 1500) : stripped;
  return [
    'You are a sales reply classifier for a Japanese B2B outreach inbox.',
    'Classify the PROSPECT\'S OWN reply text (quoted original-email content has already been removed) into exactly ONE label:',
    '  POSITIVE  — interested, asking for details, wants to proceed, echoing the CTA phrase (e.g. "見てみたい", "ぜひ", "詳しく聞かせてください", "興味あります").',
    '  OPTOUT    — asks us to stop sending email / unsubscribe / remove them from the list (e.g. "配信停止", "配信を停止してください", "今後メールを送らないでください", "送信しないでください", "unsubscribe", "remove me"). An unsubscribe notice that is only part of OUR original email footer does not count.',
    '            An explicit request to stop contact is OPTOUT even when a reason comes with it (e.g. "今後の連絡を希望しません。キャパオーバーのため").',
    '            Insults, mockery or abuse (e.g. "ペテン師", "詐欺", "ふざけるな", slurs) are OPTOUT too: we never answer them and never write again.',
    '            Asking us to write to another person or address from now on (e.g. "今後は下記私宛に返答してください" + an address) is NOT OPTOUT: label it by what they want, usually POSITIVE.',
    '  NEGATIVE  — declined or not interested, but did NOT ask us to stop emailing (e.g. "不要です", "結構です", "今回は見送ります", "必要ありません").',
    '            Polite declines are NEGATIVE even when they thank us at length: e.g. "ご提案をお願いするような状況ではございません。ご理解いただけますと幸いです", "現在は検討しておりません", "今のところ予定はございません", "お気持ちだけ頂戴します", "社内で対応しておりますので".',
    '  OOB       — out-of-office / temporary unavailability auto-reply (vacation, business trip).',
    '  AUTO      — bounce, mailer-daemon, system notification, no human authored this.',
    '  UNCLEAR   — genuinely cannot tell from the message.',
    'Respond with the LABEL ONLY (one word, uppercase). No explanation.',
    '',
    '--- PROSPECT REPLY ---',
    truncated,
    '----------------------',
  ].join('\n');
}

/**
 * Classify an inbound reply via the AI service.
 *
 * Returns both the resolved verdict and an `uncertain` flag. `uncertain` is
 * true when the classifier produced a literal `UNCLEAR` verdict OR when the
 * AI response could not be parsed into a known label at all (fallback path).
 * Callers can persist `uncertain` to surface ambiguous classifications in the
 * CRM UI without changing the action taken by `STATE_MAP`.
 *
 * @param {object} opts
 * @param {string} opts.body
 * @param {object} opts.ai - AiService-like { complete(...) }
 * @param {string} opts.tenantId
 * @param {string|null} [opts.leadId]
 * @returns {Promise<{verdict: 'optout'|'positive'|'negative'|'oob'|'auto'|'unclear', uncertain: boolean}>}
 */
// Sonnet, not Haiku 5.5 (2026-11-08): over the 535 stored replies Haiku 5.5 answered
// OOB for plain human replies (Acme's sample request, 「見てみたい」) and filed 14
// explicit stop requests as NEGATIVE; Sonnet 5.5 matched 22 of the 23 verdicts a
// person had corrected.
export const CLASSIFIER_MODEL = 'claude-sonnet-5-5';

export async function classifyReply({ body, ai, tenantId, leadId = null }) {
  const prompt = buildPrompt(body ?? '');
  const result = await ai.complete({
    tenantId,
    leadId,
    operation: 'reply_classify',
    prompt,
    model: CLASSIFIER_MODEL,
    maxTokens: 8,
  });
  const raw = (result?.text ?? '').trim().toLowerCase();
  // Allow whole-word matches anywhere in the (short) response.
  const parsed = [...VALID].find((v) => raw === v)
    ?? [...VALID].find((v) => new RegExp(`\\b${v}\\b`).test(raw))
    ?? null;
  // Unparseable AI output → treat as unclear AND flag as uncertain so the
  // founder knows the verdict is a fallback, not a real classification.
  const { verdict, overridden } = applyTextRules(parsed ?? 'unclear', body);
  // A label the text rules changed is flagged too, so a person checks it.
  return { verdict, uncertain: !parsed || verdict === 'unclear' || overridden };
}
