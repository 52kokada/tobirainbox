// Wall-clock time in a named timezone, without depending on this computer's clock or zone.
// zoned(d, tz) returns a Date whose getUTC* fields read as the wall clock in tz.
// fromZoned(y, mo, d, h, mi, tz) is the inverse: the instant when tz's wall clock shows that time.
// Fields overflow like Date.UTC (d + 1 at month end is fine). Used by the browser and by tests.
const fmts = new Map();
function fmt(tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmts.set(tz, f);
  }
  return f;
}

export function zoned(d, tz) {
  const ms = new Date(d).getTime();
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(ms)) p[type] = Number(value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return new Date(wall + (((ms % 1000) + 1000) % 1000));
}

const offsetAt = (ms, tz) => zoned(ms, tz).getTime() - ms;

export function fromZoned(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo, d, h, mi);
  const first = wall - offsetAt(wall, tz);
  return new Date(wall - offsetAt(first, tz));
}

/** 予約送信 quick choices in tz: business-hours slots the reader is likely to see. */
export function schedulePresets(now = new Date(), tz = 'Asia/Tokyo') {
  const n = zoned(now, tz); const y = n.getUTCFullYear(); const mo = n.getUTCMonth(); const d = n.getUTCDate(); const h = n.getUTCHours(); const dow = n.getUTCDay();
  const at = (dd, hh) => fromZoned(y, mo, dd, hh, 0, tz);
  const out = [];
  if (h < 8) out.push({ key: 'morning', at: at(d, 9) });
  if (h < 17) out.push({ key: 'evening', at: at(d, 18) });
  out.push({ key: 'tmrMorning', at: at(d + 1, 9) }, { key: 'tmrAfternoon', at: at(d + 1, 13) });
  const toMon = ((8 - dow) % 7) || 7;
  if (toMon > 1) out.push({ key: 'monday', at: at(d + toMon, 9) });
  return out.map((p) => ({ ...p, at: p.at.toISOString() }));
}
