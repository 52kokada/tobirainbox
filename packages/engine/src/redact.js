// packages/engine/src/redact.js
// Remove contact details before a draft/reply pair is kept as a learning
// example (D29). Rule pass here; an optional model pass for personal names is
// layered on top by the caller. `assertRedacted` refuses to let an email
// address or phone number through.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// JP and international phone shapes: 03-1234-5678, 090 1234 5678, +81-90-..., (03)1234-5678, ０３−… (full-width)
const PHONE_RE = /(?:\+?\d{1,3}[\s\-‐−ー.]?)?(?:\(?\d{2,4}\)?[\s\-‐−ー.]?)\d{2,4}[\s\-‐−ー.]?\d{3,4}/g;
const POSTAL_RE = /〒?\s?\d{3}[\-‐−ー]\d{4}/g;
const URL_PATH_RE = /https?:\/\/[^\s<>"）)]+/g;
const SAMA_RE = /([一-龯ぁ-んァ-ヶー]{1,8})(様|さま|さん|殿)/g;

function toHalfWidthDigits(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[－−‐]/g, '-');
}

/**
 * @param {string} text
 * @param {{keepHosts?: string[], names?: string[]}} [opts]
 *   keepHosts: URL hosts that are the business's own public pages (kept).
 *   names: known personal names to replace (e.g. from the From header).
 */
export function redact(text, { keepHosts = [], names = [] } = {}) {
  let s = toHalfWidthDigits(String(text ?? ''));
  s = s.replace(EMAIL_RE, '［メール］');
  s = s.replace(URL_PATH_RE, (url) => {
    try {
      const host = new URL(url).host.toLowerCase();
      return keepHosts.some((h) => host === h || host.endsWith(`.${h}`)) ? url : '［URL］';
    } catch { return '［URL］'; }
  });
  s = s.replace(POSTAL_RE, '［郵便番号］');
  s = s.replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 9 ? '［電話番号］' : m));
  for (const n of names.filter((x) => x && x.length >= 2)) {
    s = s.split(n).join('［氏名］');
  }
  s = s.replace(SAMA_RE, '［氏名］$2');
  return s;
}

export function assertRedacted(text) {
  const s = toHalfWidthDigits(String(text ?? ''));
  if (EMAIL_RE.test(s)) throw new Error('redaction failed: email address survived');
  EMAIL_RE.lastIndex = 0;
  const phones = s.match(PHONE_RE) ?? [];
  if (phones.some((m) => m.replace(/\D/g, '').length >= 9)) {
    throw new Error('redaction failed: phone number survived');
  }
  return true;
}
