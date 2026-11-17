// packages/engine/src/dates.js — date detection (calendar plan §5, D3, D35, D36, D38, D42).
// Pure functions: a deterministic pre-filter so most mail never reaches the model, a MIME walker and ICS
// parser so calendar invites never reach it either, the fixed (cacheable) prompt, and the parser that
// turns the model's JSON into local times plus the zone they are in. The server does the call and storage.

export const DATE_KINDS = ['offer', 'confirm', 'change', 'cancel'];
export const DEFAULT_MEETING_MINUTES = 30; // D38

// ---- pre-filter ---------------------------------------------------------------------------------

// Each pattern is a date, time or scheduling form. Recall matters more than precision here: a miss
// means a date is never seen, a false hit only costs one small cached call.
const HINTS = [
  /\d{1,2}\s*\/\s*\d{1,2}/, // 11/9
  /\d{1,2}\s*月\s*\d{1,2}\s*日/, // 11月9日
  /\d{1,2}\s*日\s*[(（]\s*[月火水木金土日]/, // 9日(月)
  /[(（]\s*[月火水木金土日]\s*(?:曜日?)?\s*[)）]/, // (月)
  /[月火水木金土日]曜/,
  /来週|再来週|今週|明日|明後日|あす|あさって|週明け|月末|月初|来月/,
  /\d{1,2}\s*(?:時|:\d{2})/, // 14時, 14:00
  /午前|午後|正午|夕方|朝一/,
  /ご都合|都合|日程|日時|候補|打ち?合わ?せ|ミーティング|\bMTG\b|面談|面接|商談|ご来社|ご訪問|訪問|伺い|リスケ|延期|キャンセル|中止|予定/,
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)(?!\w)/i,
  /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i,
  /\b(?:today|tomorrow|tonight|next week|this week|next month)\b/i,
  /\b(?:schedul\w*|reschedul\w*|availab\w*|meeting|meet|call|slot|calendar|invite|cancel\w*|postpone\w*)\b/i,
  /\b(?:JST|PT|PST|PDT|ET|EST|EDT|CT|CST|CDT|GMT|UTC|BST|CET|CEST|SGT|KST|AEST|AEDT)\b/,
];

const normalize = (s) => String(s ?? '').normalize('NFKC');

// Preview interest (D54): a client asking for, or open to, a preview or sample site. Same recall-first
// idea as HINTS: a false hit costs a field in the date call, a miss loses the flag.
const PREVIEW_HINTS = [
  /プレビュー|サンプル|試作|見本|デモ|モックアップ|たたき台|叩き台|イメージ(?:案|を見|が見|だけでも)/,
  /見てみたい|見せて(?:いただ|もら|くだ|ほし)|拝見したい|作って(?:いただ|もら|みて)/,
  /\b(?:preview|sample|mock-?up|demo|prototype|example site|draft site)s?\b/i,
];

/** True when the text may say the sender wants a preview or sample site (D54). Never calls a model. */
export function hasPreviewHints(text) {
  const t = normalize(text);
  return PREVIEW_HINTS.some((re) => re.test(t));
}

/**
 * True when the text has any date, time or scheduling form, or when the message carries a calendar
 * part (those are parsed directly, never sent to the model).
 * @param {string} text   message text, quoted earlier mail removed
 * @param {Array} [parts] result of findCalendarParts(payload)
 */
export function hasDateHints(text, parts = []) {
  if (parts?.length) return true;
  const t = normalize(text);
  return HINTS.some((re) => re.test(t));
}

// ---- MIME walker --------------------------------------------------------------------------------

const b64 = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const isCalendar = (p) => /^(?:text\/calendar|application\/ics)\b/i.test(p.mimeType ?? '') || /\.ics$/i.test(p.filename ?? '');

/**
 * Every text/calendar part and .ics attachment in a Gmail API message payload, at any depth, including
 * nested multipart/* and forwarded message/rfc822 parts.
 * → [{ partId, mimeType, filename, text|null, attachmentId|null }]  (text is set when the body is inline)
 */
export function findCalendarParts(payload) {
  const out = [];
  const walk = (p, depth) => {
    if (!p || depth > 20) return;
    if (isCalendar(p)) {
      out.push({
        partId: p.partId ?? null, mimeType: p.mimeType ?? null, filename: p.filename || null,
        text: p.body?.data ? b64(p.body.data) : null, attachmentId: p.body?.attachmentId ?? null,
      });
    }
    for (const c of p.parts ?? []) walk(c, depth + 1);
  };
  walk(payload, 0);
  return out;
}

// ---- time zones ---------------------------------------------------------------------------------

// Abbreviations a sender writes, and the Windows names Outlook puts in TZID, mapped to IANA zones.
const TZ_ALIASES = {
  jst: 'Asia/Tokyo', pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles',
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver',
  gmt: 'UTC', utc: 'UTC', z: 'UTC', bst: 'Europe/London', cet: 'Europe/Paris', cest: 'Europe/Paris',
  sgt: 'Asia/Singapore', kst: 'Asia/Seoul', aest: 'Australia/Sydney', aedt: 'Australia/Sydney',
  'tokyo standard time': 'Asia/Tokyo', 'pacific standard time': 'America/Los_Angeles',
  'eastern standard time': 'America/New_York', 'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver', 'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin', 'romance standard time': 'Europe/Paris',
  'singapore standard time': 'Asia/Singapore', 'korea standard time': 'Asia/Seoul',
  'aus eastern standard time': 'Australia/Sydney', 'china standard time': 'Asia/Shanghai',
};

/** An IANA zone name for what a sender or calendar wrote, or null when it is not one we know. */
export function normalizeTz(tz) {
  if (!tz) return null;
  const s = String(tz).trim().replace(/^"|"$/g, '');
  const alias = TZ_ALIASES[s.toLowerCase()];
  if (alias) return alias;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone; } catch { return null; }
}

const fmtCache = new Map();
function offsetMinutes(utcMs, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** "2026-11-10T14:00" wall-clock in `tz` → ISO UTC string. Uses the offset at that moment (DST-safe). */
export function localToUtc(local, tz) {
  const m = LOCAL_RE.exec(String(local));
  if (!m) throw new Error(`bad local time: ${local}`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  let utc = wall - offsetMinutes(wall, tz) * 60_000;
  utc = wall - offsetMinutes(utc, tz) * 60_000; // second pass settles times next to a DST change
  return new Date(utc).toISOString();
}

const pad = (n) => String(n).padStart(2, '0');

/** ISO/UTC instant → { local: "YYYY-MM-DDTHH:MM", weekday: 0-6 } in `tz`. */
export function utcToLocal(instant, tz) {
  const ms = new Date(instant).getTime();
  const w = new Date(ms + offsetMinutes(ms, tz) * 60_000);
  return {
    local: `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`,
    weekday: w.getUTCDay(),
  };
}

const addMinutesLocal = (local, min) => {
  const m = LOCAL_RE.exec(local);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) + min * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

// ---- ICS ----------------------------------------------------------------------------------------

function icsTime(value, params, fallbackTz) {
  const v = String(value).trim();
  const allDay = /VALUE=DATE(?!-)/i.test(params) || /^\d{8}$/.test(v);
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}`;
  if (m[7]) return { utc: new Date(`${local}:${m[6] ?? '00'}Z`).toISOString(), tz: 'UTC', allDay };
  const tzid = /TZID=("?)([^";:]+)\1/i.exec(params)?.[2];
  const tz = normalizeTz(tzid) ?? fallbackTz;
  if (!tz) return null;
  return { utc: localToUtc(local, tz), tz, allDay, tzGuessed: !normalizeTz(tzid) };
}

function durationMs(d) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(d).trim());
  if (!m) return null;
  const sec = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400) + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0);
  return (m[1] === '-' ? -1 : 1) * sec * 1000;
}

/**
 * Parse an iCalendar invite (RFC 5545 subset: METHOD, VEVENT with DTSTART/DTEND/DURATION, STATUS, UID).
 * Floating times and unknown TZIDs are read in `fallbackTz` (the business zone).
 * → { method, events: [{ uid, kind, startUtc, endUtc, tz, allDay, summary, location, sequence }] }
 */
export function parseIcs(text, { fallbackTz = null } = {}) {
  const lines = String(text ?? '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  let method = null; const events = []; let ev = null;
  for (const line of lines) {
    const i = line.indexOf(':'); if (i < 0) continue;
    const head = line.slice(0, i); const value = line.slice(i + 1);
    const [name, ...rest] = head.split(';'); const params = rest.join(';'); const key = name.toUpperCase();
    if (key === 'METHOD' && !ev) method = value.trim().toUpperCase();
    else if (key === 'BEGIN' && value.trim().toUpperCase() === 'VEVENT') ev = {};
    else if (key === 'END' && value.trim().toUpperCase() === 'VEVENT' && ev) { events.push(ev); ev = null; }
    else if (ev) {
      if (key === 'DTSTART') ev.start = icsTime(value, params, fallbackTz);
      else if (key === 'DTEND') ev.end = icsTime(value, params, fallbackTz);
      else if (key === 'DURATION') ev.duration = durationMs(value);
      else if (key === 'UID') ev.uid = value.trim();
      else if (key === 'SUMMARY') ev.summary = unescape(value);
      else if (key === 'LOCATION') ev.location = unescape(value);
      else if (key === 'STATUS') ev.status = value.trim().toUpperCase();
      else if (key === 'SEQUENCE') ev.sequence = Number(value) || 0;
    }
  }
  return {
    method,
    events: events.filter((e) => e.start).map((e) => {
      const startMs = new Date(e.start.utc).getTime();
      const endUtc = e.end?.utc
        ?? (e.duration != null ? new Date(startMs + e.duration).toISOString() : null)
        ?? new Date(startMs + (e.start.allDay ? 86400_000 : DEFAULT_MEETING_MINUTES * 60_000)).toISOString();
      const cancelled = method === 'CANCEL' || e.status === 'CANCELLED';
      return {
        uid: e.uid ?? null, kind: cancelled ? 'cancel' : (e.sequence > 0 ? 'change' : 'confirm'),
        startUtc: e.start.utc, endUtc, tz: e.start.tz, allDay: e.start.allDay,
        summary: e.summary ?? null, location: e.location ?? null, sequence: e.sequence ?? 0,
      };
    }),
  };
}

// ---- model prompt -------------------------------------------------------------------------------

// Fixed text, sent as the cached system block (ai.js). Per-message facts go in the user turn. Plain
// task and schema only; tests keep it byte-stable and free of prompt rituals.
export const DATE_SYSTEM_PROMPT = `Find the meeting dates and times in one email and return them as JSON.

The user turn gives the email's sent time in the business time zone (with its weekday), the business time zone, who wrote the email (us or them), and the email text with quoted earlier mail removed.

Reply with only this JSON object:
{"dates":[{"start":"YYYY-MM-DDTHH:MM","end":"YYYY-MM-DDTHH:MM or null","tz":"IANA zone or null","kind":"offer|confirm|change|cancel","quote":"the words that give this time, up to 60 characters"}],"preview":{"due":"YYYY-MM-DD or null","quote":"the words that ask for it, up to 60 characters"}}
Reply {"dates":[]} when the email names no meeting time. Add "preview" only when it applies (see the last rule).

Rules:
- start and end are wall-clock times in the zone the time is written in. Set tz only when the email states a zone for that time (PT is America/Los_Angeles, ET is America/New_York, JST is Asia/Tokyo, GMT and UTC are UTC). With no stated zone, tz is null and the time is read in the business time zone.
- Resolve relative dates from the sent date: 明日 and tomorrow are the next day; 今週 and this week are the sent date's week; 来週 and next week are the following Monday-to-Sunday week; 再来週 is the week after that. A weekday alone (火曜, Tuesday) is the next such day after the sent date. A month and day with no year is the next such date on or after the sent date.
- A range (10:00〜12:00, 2-4pm) gives start and end. A start alone gives end null. 午前 or morning with no hour is 09:00 to 12:00; 午後 or afternoon with no hour is 13:00 to 18:00.
- One entry per option. "Mon or Tue afternoon" is two entries; "11/9か11/10の10時" is two entries.
- kind: offer is a time proposed or asked about and not yet agreed. confirm is a time this email accepts or fixes (承知しました, その日時でお願いします, see you then). change moves an agreed meeting; give only the new time. cancel calls a meeting off; give the cancelled time, or the date with 00:00 when the email gives no hour.
- Leave out times that are not meetings: deadlines, delivery or shipping dates, business hours, office closures, past events, signatures, and times inside quoted earlier mail.
- preview: add it when the email is written by them and says they want, or would like to see, a preview, sample or demo of a website or page we would make for them (プレビューを見てみたい, サンプルサイトをお願いします, I'd love to see a sample). Leave it out for a polite no, a question only about price or process, a preview they already received, and mail written by us. due is the date they name for receiving it (金曜までに, by Nov 20), resolved like the dates above; null when they name none. That date is not a meeting, so it is not in dates.

Examples (sent 2026-11-06 (Fri) 10:00, business zone Asia/Tokyo):
来週火曜14時はいかがでしょうか。
{"dates":[{"start":"2026-11-10T14:00","end":null,"tz":null,"kind":"offer","quote":"来週火曜14時"}]}
11/9(月)10:00〜11:00、11/11(水)15:00〜のどちらかでお願いできますか。
{"dates":[{"start":"2026-11-09T10:00","end":"2026-11-09T11:00","tz":null,"kind":"offer","quote":"11/9(月)10:00〜11:00"},{"start":"2026-11-11T15:00","end":null,"tz":null,"kind":"offer","quote":"11/11(水)15:00〜"}]}
Could we do 3pm PT on Monday instead of Tuesday?
{"dates":[{"start":"2026-11-09T15:00","end":null,"tz":"America/Los_Angeles","kind":"change","quote":"3pm PT on Monday"}]}
お見積りは11月20日までにお送りします。
{"dates":[]}
ぜひサンプルサイトを見てみたいです。来週水曜までにいただけると助かります。
{"dates":[],"preview":{"due":"2026-11-11","quote":"サンプルサイトを見てみたいです"}}`;

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_BODY_CHARS = 4000;

/**
 * The request for ai.complete(): fixed system block + this message's facts.
 * @param {{text:string, sentAt:string|Date, businessTz:string, direction:'ours'|'theirs'}} o
 */
export function buildDateRequest({ text, sentAt, businessTz, direction }) {
  const tz = normalizeTz(businessTz);
  if (!tz) throw new Error(`unknown business time zone: ${businessTz}`);
  const { local, weekday } = utcToLocal(sentAt, tz);
  const body = String(text ?? '').slice(0, MAX_BODY_CHARS);
  const variable = [
    `Sent: ${local.replace('T', ' ')} (${WEEKDAYS_EN[weekday]} / ${WEEKDAYS[weekday]})`,
    `Business time zone: ${tz}`,
    `Written by: ${direction === 'ours' ? 'us' : 'them'}`,
    'Email:',
    body,
  ].join('\n');
  return { operation: 'dates', cacheable: DATE_SYSTEM_PROMPT, variable, maxTokens: 600 };
}

/**
 * The model's reply → [{ startLocal, endLocal|null, statedTz|null, kind, quote }]. Throws on anything
 * that is not the schema (the caller logs it and makes no suggestion).
 */
export function parseDateResult(json) {
  let obj = json;
  if (typeof json === 'string') {
    const s = json.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    obj = JSON.parse(s);
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.dates)) throw new Error('date result: no dates array');
  const seen = new Set();
  const out = [];
  for (const d of obj.dates) {
    if (!d || typeof d !== 'object') throw new Error('date result: entry is not an object');
    const start = String(d.start ?? '');
    if (!LOCAL_RE.test(start)) throw new Error(`date result: bad start ${start}`);
    const end = d.end == null || d.end === 'null' ? null : String(d.end);
    if (end != null && !LOCAL_RE.test(end)) throw new Error(`date result: bad end ${end}`);
    if (!DATE_KINDS.includes(d.kind)) throw new Error(`date result: bad kind ${d.kind}`);
    const statedTz = d.tz == null || d.tz === 'null' || d.tz === '' ? null : normalizeTz(d.tz);
    if (d.tz && d.tz !== 'null' && !statedTz) throw new Error(`date result: unknown zone ${d.tz}`);
    const startLocal = start.length === 10 ? `${start}T00:00` : start.slice(0, 16);
    const key = `${startLocal}|${statedTz}|${d.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ startLocal, endLocal: end ? (end.length === 10 ? `${end}T00:00` : end.slice(0, 16)) : null, statedTz, kind: d.kind, quote: String(d.quote ?? '').slice(0, 80) });
  }
  return out;
}

/**
 * Parsed dates → stored form (D35: sender-stated zone, else business zone; D38: 30 minutes when no end).
 * → [{ startUtc, endUtc, tz, tzSource:'stated'|'business', startLocal, endLocal, kind, quote, direction }]
 */
export function resolveDates(items, { businessTz, direction }) {
  const btz = normalizeTz(businessTz);
  return items.map((d) => {
    const tz = d.statedTz ?? btz;
    const endLocal = d.endLocal && d.endLocal > d.startLocal ? d.endLocal : addMinutesLocal(d.startLocal, DEFAULT_MEETING_MINUTES);
    return {
      startUtc: localToUtc(d.startLocal, tz), endUtc: localToUtc(endLocal, tz), tz,
      tzSource: d.statedTz ? 'stated' : 'business', startLocal: d.startLocal, endLocal,
      kind: d.kind, quote: d.quote, direction,
    };
  });
}

// ---- preview deadlines (D54, D55) ---------------------------------------------------------------

export const PREVIEW_RULE_DAYS = 3; // D55: calendar days after the positive reply
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The model reply's "preview" field → { due: 'YYYY-MM-DD'|null, quote } or null when it is absent.
 * Lenient on its own fields (a bad due is read as none): the dates part decides whether the reply is valid.
 */
export function parsePreviewResult(json) {
  let obj = json;
  if (typeof json === 'string') obj = JSON.parse(json.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const p = obj?.preview;
  if (!p || typeof p !== 'object' || p.wanted === false) return null;
  const due = typeof p.due === 'string' && DATE_ONLY_RE.test(p.due.slice(0, 10)) ? p.due.slice(0, 10) : null;
  return { due, quote: String(p.quote ?? '').slice(0, 80) };
}

const addDaysDate = (ymd, n) => {
  const m = DATE_ONLY_RE.exec(ymd);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/**
 * D55: the date the client named, else 3 calendar days after the reply's sent date, both as a date in
 * the business zone. A named date before the sent date is read as a slip and the rule date is used.
 * → { due: 'YYYY-MM-DD', source: 'mail_date'|'rule' }
 */
export function previewDueDate(preview, { sentAt, businessTz }) {
  const tz = normalizeTz(businessTz) ?? 'Asia/Tokyo';
  const sentDay = utcToLocal(sentAt, tz).local.slice(0, 10);
  if (preview?.due && preview.due >= sentDay) return { due: preview.due, source: 'mail_date' };
  return { due: addDaysDate(sentDay, PREVIEW_RULE_DAYS), source: 'rule' };
}

/**
 * Our sent mail carries a preview link (D57): https://<preview host>/<something>-preview/...
 * The host defaults to example.com; set PREVIEW_LINK_HOST to match your own preview host.
 */
export function previewLinkRe(host = 'example.com') {
  const h = String(host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`https?:\\/\\/(?:www\\.)?${h}\\/[\\w-]+-preview(?:[/?#][^\\s<>"')）」]*)?(?=$|[\\s<>"')）」、。,])`, 'i');
}
export const PREVIEW_LINK_RE = previewLinkRe(globalThis.process?.env?.PREVIEW_LINK_HOST || undefined);
export function hasPreviewLink(text) { return PREVIEW_LINK_RE.test(String(text ?? '')); }
