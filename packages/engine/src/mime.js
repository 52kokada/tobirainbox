// packages/engine/src/mime.js
// Build a threaded reply as RFC 822, multipart/alternative (text + HTML) by
// default or text-only when the business chose plain text (D16). The quoted
// block mirrors Gmail's own reply ("<date> <sender> wrote:" + blockquote).

export function encodeHeader(s) {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// Japanese businesses: dates are written in Japan time (no daylight saving, always +0900), whatever
// the server's or the Google account's own time zone is.
const JST_MIN = 9 * 60;
const pad2 = (n) => String(n).padStart(2, '0');
const jst = (d) => new Date(new Date(d).getTime() + JST_MIN * 60_000);

/** RFC 5322 Date header in Japan time, e.g. "Thu, 06 Nov 2026 12:00:00 +0900". */
export function rfcDateJst(d = new Date()) {
  const t = jst(d);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()];
  return `${day}, ${pad2(t.getUTCDate())} ${mon} ${t.getUTCFullYear()} ${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())} +0900`;
}

/** "2026年11月6日(木) 12:00" in Japan time, for the quoted-reply line. */
export function jaDateJst(d) {
  const ms = new Date(d).getTime();
  if (Number.isNaN(ms)) return String(d ?? '');
  const t = jst(ms);
  return `${t.getUTCFullYear()}年${t.getUTCMonth() + 1}月${t.getUTCDate()}日(${'日月火水木金土'[t.getUTCDay()]}) ${t.getUTCHours()}:${pad2(t.getUTCMinutes())}`;
}

/** "名前 <a@b>" with the display name encoded when not ASCII. */
export function formatAddress(name, email) {
  if (!name) return email;
  return `${encodeHeader(name)} <${email}>`;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text → Gmail-like HTML: one <div> per line, empty lines kept. */
export function textToHtml(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n')
    .map((line) => (line.trim() === '' ? '<div><br></div>' : `<div>${escapeHtml(line)}</div>`))
    .join('');
}

function base64Lines(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

/**
 * @param {object} o
 * @param {{name?:string,email:string}} o.from
 * @param {Array<{name?:string,email:string}>} o.to
 * @param {Array<{name?:string,email:string}>} [o.cc]
 * @param {string} o.subject
 * @param {string} o.text                 reply body (plain text as edited)
 * @param {string} [o.signatureHtml]      Gmail sendAs signature HTML (used instead of the text signature in HTML part when given)
 * @param {{date:string, from:string, text:string}} [o.quote]  message being answered
 * @param {string} [o.inReplyTo]
 * @param {string} [o.references]
 * @param {boolean} [o.plainText]
 * @param {string} [o.boundary]
 * @param {Date|string} [o.date]          Date header (default now), written in Japan time
 */
export function buildReplyMime(o) {
  // Our own Date header, in Japan time. Gmail's send API replaces it with a zone of its own choosing
  // (round-trip test 2026-11-06: −0800, then −0600), so recipients may see another offset; mail apps
  // show the time in the reader's zone anyway. The quoted-reply line (jaDateJst) is what stays JST.
  const headers = [
    `Date: ${rfcDateJst(o.date ?? new Date())}`,
    `From: ${formatAddress(o.from.name, o.from.email)}`,
    `To: ${o.to.map((a) => formatAddress(a.name, a.email)).join(', ')}`,
  ];
  if (o.cc?.length) headers.push(`Cc: ${o.cc.map((a) => formatAddress(a.name, a.email)).join(', ')}`);
  headers.push(`Subject: ${encodeHeader(o.subject)}`, 'MIME-Version: 1.0');
  if (o.inReplyTo) headers.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.inReplyTo || o.references) headers.push(`References: ${[o.references, o.inReplyTo].filter(Boolean).join(' ')}`);

  const quoteText = o.quote
    ? `\n\n${o.quote.date} ${o.quote.from}:\n\n${String(o.quote.text).split('\n').map((l) => `> ${l}`).join('\n')}\n`
    : '';
  const fullText = `${o.text}${quoteText}`;
  const files = (o.attachments ?? []).filter((f) => f && f.data);

  // The body as one MIME part (its own headers + content): text only, or text + HTML.
  let body;
  if (o.plainText) {
    body = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Lines(fullText)].join('\r\n');
  } else {
    const html = [
    `<div dir="ltr">${textToHtml(o.text)}${o.signatureHtml ? `<div><br></div>${o.signatureHtml}` : ''}</div>`,
    o.quote
      ? `<br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(o.quote.date)} ${escapeHtml(o.quote.from)}:<br></div>`
        + `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${textToHtml(o.quote.text)}</blockquote></div>`
      : '',
  ].join('');
    const b = o.boundary ?? `tobira-inbox_${Math.random().toString(36).slice(2)}`;
    body = [`Content-Type: multipart/alternative; boundary="${b}"`, '',
      `--${b}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Lines(fullText),
      `--${b}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Lines(html),
      `--${b}--`].join('\r\n');
  }

  if (!files.length) return `${headers.join('\r\n')}\r\n${body}\r\n`;

  // Attachments: multipart/mixed = the body part, then each file. Japanese file names go in RFC 2047
  // encoded words (as Gmail and Outlook write them): Gmail's send API drops RFC 2231 filename*, which
  // left recipients with "___.txt" (round-trip test 2026-11-06).
  const m = `tobira-inbox_mixed_${Math.random().toString(36).slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${m}"`);
  return [
    headers.join('\r\n'), '',
    `--${m}`, body,
    ...files.flatMap((f) => [`--${m}`,
      `Content-Type: ${f.mimeType || 'application/octet-stream'}; name="${fileWord(f.filename)}"`,
      `Content-Disposition: attachment; filename="${fileWord(f.filename)}"`,
      'Content-Transfer-Encoding: base64', '', wrap76(f.data)]),
    `--${m}--`, '',
  ].join('\r\n');
}

/** File name for a quoted MIME parameter: ASCII as is, anything else as one UTF-8 B encoded word. */
const fileWord = (n) => {
  const s = String(n || 'file').replace(/["\\\r\n]/g, '_');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
};
/** Standard base64 (accepts base64url too), wrapped at 76 columns. */
const wrap76 = (b64) => String(b64).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '').replace(/.{76}/g, '$&\r\n');

/** Gmail API `raw` field. */
export function toBase64Url(rfc822) {
  return Buffer.from(rfc822, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
