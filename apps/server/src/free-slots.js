// apps/server/src/free-slots.js — free times to offer in a reply (calendar plan step 12; D4, D9, D22, D49).
// One freeBusy call reads the thread owner's primary calendar, each ticked attendee's primary calendar and
// always the 調整中 calendar (its shadow twin in shadow mode), so a time already held for someone else is
// never offered twice. Ticked attendees are used only for this read: they are not added to holds or
// meetings (M12). The hours come from businesses.free_slot_hours in the business timezone (D49).
// Read-only: no Google write happens here.
import { localToUtc, utcToLocal } from '@tobira-inbox/engine';
import { DEFAULT_FREE_SLOT_HOURS, parseFreeSlotHours } from './store.js';

export class FreeSlotError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

const MIN = 60_000;
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const hm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/**
 * Candidate starts inside the business hours, free of every busy interval.
 * → [{ start, end }] ISO UTC, in time order. Pure: no Google call.
 */
export function openSlots({ busy = [], from, to, durationMin = 30, stepMin = 30, businessTz = 'Asia/Tokyo', hours = DEFAULT_FREE_SLOT_HOURS, leadMin = 60, now = new Date() }) {
  const h = parseFreeSlotHours(hours) ?? DEFAULT_FREE_SLOT_HOURS;
  const earliest = Math.max(Date.parse(from), now.getTime() + leadMin * MIN);
  const latest = Date.parse(to);
  const intervals = busy.map((b) => [Date.parse(b.start), Date.parse(b.end)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const out = [];
  const first = utcToLocal(new Date(Date.parse(from)).toISOString(), businessTz).local.slice(0, 10);
  const [y, mo, d] = first.split('-').map(Number);
  for (let i = 0; ; i += 1) {
    const day = new Date(Date.UTC(y, mo - 1, d + i));
    const date = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    if (Date.parse(localToUtc(`${date}T00:00`, businessTz)) >= latest) break;
    if (!h.days.includes(day.getUTCDay())) continue;
    for (let m = toMin(h.from); m + durationMin <= toMin(h.to); m += stepMin) {
      const start = Date.parse(localToUtc(`${date}T${hm(m)}`, businessTz));
      const end = start + durationMin * MIN;
      if (start < earliest || end > latest) continue;
      if (intervals.some(([a, b]) => a < end && b > start)) continue;
      out.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    }
    if (i > 400) break;
  }
  return out;
}

/** Up to n slots, spread out: the first free slot of each day first, then the rest in time order. */
export function pickSlots(slots, n = 3, businessTz = 'Asia/Tokyo') {
  const byDay = new Map();
  for (const s of slots) {
    const day = utcToLocal(s.start, businessTz).local.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, s);
  }
  const picked = [...byDay.values()].slice(0, n);
  for (const s of slots) { if (picked.length >= n) break; if (!picked.includes(s)) picked.push(s); }
  return picked.sort((a, b) => a.start.localeCompare(b.start));
}

/** The 調整中 calendar a freeBusy read must include (shadow mode: its test twin). */
export function holdCalendarFor(business) {
  return business.calendar_mode === 'shadow' ? business.shadow_calendar_id : business.hold_calendar_id;
}

/**
 * Free slots for a thread owner plus ticked attendees (D9). attendeeMailboxes are mailboxes rows already
 * checked by the caller (same business, visible to the viewer). One freeBusy call, made with the owner's
 * calendar client. A calendar Google cannot read fails the whole request (never offer a time we could not check).
 * → { slots: [{start,end}], asked: [calendar ids] }
 */
export async function freeSlots({ business, ownerMailbox, attendeeMailboxes = [], from, to, durationMin = 30, n = 3, clientFor, now = new Date() }) {
  if (!business || business.calendar_mode === 'off') throw new FreeSlotError('calendar_off');
  const tz = business.timezone || 'Asia/Tokyo';
  const hold = holdCalendarFor(business);
  if (!hold) throw new FreeSlotError('no_hold_calendar', 'the 調整中 calendar is not set up');
  const fromIso = new Date(from ?? now).toISOString();
  const toIso = new Date(to ?? (now.getTime() + 14 * DAY)).toISOString();
  const ids = [...new Set([ownerMailbox.address, ...attendeeMailboxes.map((m) => m.address), hold])];
  const res = await clientFor(ownerMailbox).freeBusy({ timeMin: fromIso, timeMax: toIso, ids, timeZone: tz });
  const unreadable = ids.filter((id) => !res[id] || res[id].errors?.length);
  if (unreadable.length) throw new FreeSlotError('calendar_unreadable', `could not read: ${unreadable.join(', ')}`);
  const busy = ids.flatMap((id) => res[id].busy ?? []);
  const hours = parseFreeSlotHours(business.free_slot_hours) ?? DEFAULT_FREE_SLOT_HOURS;
  const slots = pickSlots(openSlots({ busy, from: fromIso, to: toIso, durationMin, businessTz: tz, hours, now }), n, tz);
  return { slots, asked: ids };
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const TZ_JA = { 'Asia/Tokyo': '日本時間' };

/** "11月10日(火) 10:00〜10:30" in the business timezone. */
export function slotLabel(slot, tz = 'Asia/Tokyo') {
  const a = utcToLocal(slot.start, tz); const b = utcToLocal(slot.end, tz);
  const [, m, d] = a.local.slice(0, 10).split('-').map(Number);
  return `${m}月${d}日(${WD[a.weekday]}) ${a.local.slice(11)}〜${b.local.slice(11)}`;
}

/** The drafting instruction that offers these slots (draftForThread writes the reply in the customer's language). */
export function slotsInstruction(slots, tz = 'Asia/Tokyo') {
  const zone = TZ_JA[tz] ?? tz;
  return `日程の候補として次の${slots.length}つを提示する返信にしてください（${zone}）: ${slots.map((s) => slotLabel(s, tz)).join(' / ')}。都合のよい日時を選んでいただくようお願いする。`;
}
