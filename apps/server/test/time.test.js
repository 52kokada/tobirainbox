// public/time.js replaced the hard-coded +9h jst()/fromJst() (calendar plan step 1). The 予約送信
// presets must come out exactly as before, and other zones must round-trip across DST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoned, fromZoned, schedulePresets } from '../public/time.js';

// The implementation as it was in public/app.js before the refactor, kept verbatim as the baseline.
const JST_MS = 9 * 3600_000;
const jst = (d) => new Date(new Date(d).getTime() + JST_MS);
const fromJst = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo, d, h - 9, mi));
function oldPresets(now = new Date()) {
  const n = jst(now); const y = n.getUTCFullYear(); const mo = n.getUTCMonth(); const d = n.getUTCDate(); const h = n.getUTCHours(); const dow = n.getUTCDay();
  const out = [];
  if (h < 8) out.push({ key: 'morning', at: fromJst(y, mo, d, 9, 0) });
  if (h < 17) out.push({ key: 'evening', at: fromJst(y, mo, d, 18, 0) });
  out.push({ key: 'tmrMorning', at: fromJst(y, mo, d + 1, 9, 0) }, { key: 'tmrAfternoon', at: fromJst(y, mo, d + 1, 13, 0) });
  const toMon = ((8 - dow) % 7) || 7;
  if (toMon > 1) out.push({ key: 'monday', at: fromJst(y, mo, d + toMon, 9, 0) });
  return out.map((p) => ({ ...p, at: p.at.toISOString() }));
}

test('schedule presets over 48 hourly now values are identical to the old +9h code', () => {
  // Start 2026-11-07 00:17 JST (a Saturday), crossing a weekend and a month end set separately below.
  for (const startIso of ['2026-11-06T15:17:00Z', '2026-11-29T15:42:00Z', '2026-12-30T15:05:00Z']) {
    const start = Date.parse(startIso);
    for (let i = 0; i < 48; i++) {
      const now = new Date(start + i * 3600_000);
      assert.deepEqual(schedulePresets(now), oldPresets(now), now.toISOString());
    }
  }
});

test('zoned/fromZoned in Asia/Tokyo match the old helpers', () => {
  for (let i = 0; i < 48; i++) {
    const t = Date.parse('2026-11-07T00:00:00Z') + i * 3600_000 + 123;
    assert.equal(zoned(t, 'Asia/Tokyo').getTime(), jst(t).getTime());
  }
  assert.equal(fromZoned(2026, 10, 31, 9, 30, 'Asia/Tokyo').getTime(), fromJst(2026, 10, 31, 9, 30).getTime());
});

test('America/Los_Angeles round-trips across 2026-11-01 and 2027-03-14', () => {
  for (const startIso of ['2026-10-31T00:00:00Z', '2027-03-13T00:00:00Z']) {
    const start = Date.parse(startIso);
    for (let i = 0; i < 72; i++) {
      const ms = start + i * 3600_000;
      const z = zoned(ms, 'America/Los_Angeles');
      const back = fromZoned(z.getUTCFullYear(), z.getUTCMonth(), z.getUTCDate(), z.getUTCHours(), z.getUTCMinutes(), 'America/Los_Angeles');
      // The repeated 1:00 hour on 2026-11-01 maps back to one of its two instants; every other hour is exact.
      const repeated = z.getUTCMonth() === 10 && z.getUTCDate() === 1 && z.getUTCHours() === 1;
      if (repeated) assert.ok([ms, ms - 3600_000, ms + 3600_000].includes(back.getTime()), new Date(ms).toISOString());
      else assert.equal(back.getTime(), ms, new Date(ms).toISOString());
    }
  }
  // Offsets on each side of the changes: PDT -7, PST -8.
  assert.equal(fromZoned(2026, 9, 31, 12, 0, 'America/Los_Angeles').toISOString(), '2026-10-31T19:00:00.000Z');
  assert.equal(fromZoned(2026, 10, 2, 12, 0, 'America/Los_Angeles').toISOString(), '2026-11-02T20:00:00.000Z');
  assert.equal(fromZoned(2027, 2, 13, 12, 0, 'America/Los_Angeles').toISOString(), '2027-03-13T20:00:00.000Z');
  assert.equal(fromZoned(2027, 2, 15, 12, 0, 'America/Los_Angeles').toISOString(), '2027-03-15T19:00:00.000Z');
  assert.equal(zoned('2026-11-01T09:30:00Z', 'America/Los_Angeles').toISOString(), '2026-11-01T01:30:00.000Z');
  assert.equal(zoned('2026-11-01T08:30:00Z', 'America/Los_Angeles').toISOString(), '2026-11-01T01:30:00.000Z');
});
