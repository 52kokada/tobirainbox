// packages/engine/src/auto-reply.js
// Deterministic checks that run before any model call. Ported from
// the external CRM backend (receive-worker) (isAutoReply, stripReplyPrefixes)
// and src/gmail/receive.js (parseFrom).

const REPLY_PREFIX_RE = /^(?:(?:re|fw|fwd|aw|sv|返信|回复|転送)\s*(?:\[\d+\])?\s*[:：]\s*)+/i;

const AUTO_REPLY_SUBJECT_MARKERS = [
  'automatic reply', 'automatic response', 'autoreply', 'auto reply',
  'auto-reply', 'auto response', 'auto-response', 'out of office',
  '自動応答', '自動返信',
];

/** Lower-cased bare address from a `Name <addr>` header value. */
export function parseFrom(value) {
  if (!value || typeof value !== 'string') return '';
  const m = value.match(/<([^>]+)>/);
  const raw = m ? m[1] : value;
  return raw.trim().toLowerCase();
}

/** "Re: Re: FW: X" / "返信: X" → "X"; null when what is left is under 8 chars. */
export function stripReplyPrefixes(subject) {
  if (!subject) return null;
  const s = String(subject).trim().replace(REPLY_PREFIX_RE, '').trim();
  return s.length >= 8 ? s : null;
}

/**
 * RFC 3834 Auto-Submitted, X-Autoreply, Precedence: auto_reply, then subject.
 * @param {{subject?:string, autoSubmitted?:string, autoReply?:string, precedence?:string}} msg
 */
export function isAutoReply(msg) {
  const autoSubmitted = String(msg?.autoSubmitted ?? '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (String(msg?.autoReply ?? '').trim()) return true;
  if (String(msg?.precedence ?? '').trim().toLowerCase() === 'auto_reply') return true;
  const bare = String(msg?.subject ?? '').trim().replace(REPLY_PREFIX_RE, '').trim().toLowerCase();
  return AUTO_REPLY_SUBJECT_MARKERS.some((marker) => bare.startsWith(marker));
}

/** Bulk / newsletter mail: List-Unsubscribe, List-Id or Precedence bulk/list. */
export function isBulkMail(msg) {
  if (String(msg?.listUnsubscribe ?? '').trim()) return true;
  if (String(msg?.listId ?? '').trim()) return true;
  const p = String(msg?.precedence ?? '').trim().toLowerCase();
  return p === 'bulk' || p === 'list' || p === 'junk';
}
