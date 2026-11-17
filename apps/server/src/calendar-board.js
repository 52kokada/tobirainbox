// apps/server/src/calendar-board.js — what the console's Calendar tab and thread card read (plan steps 16-17).
// Read-only: builds JSON from our own rows (meetings, holds, suggestions) plus the read cache of Google
// events (step 6). Every list is limited to the viewer's mailboxes (accessScope, D8) and private events of
// another person's calendar reach the browser as bare busy blocks (eventsForViewer, D16, D34, D39).
import { canSee } from './partner.js';
import { ownMailboxId, eventsForViewer } from './calendar-view.js';
import { openDeadlines, deadlineView, todayIn } from './deadlines.js';

/** D45: off shows nothing; shadow shows the calendar only to owners (the admin view); on shows it to everyone. */
export function calendarVisibleFor(mode, user) {
  if (mode === 'on') return true;
  if (mode === 'shadow') return user?.role === 'owner';
  return false;
}

const local = (a) => String(a ?? '').split('@')[0];
/** Gmail, for a thread that has no thread row yet (we wrote first, plan §4). */
export const gmailUrl = (address, gmailThreadId) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#all/${encodeURIComponent(gmailThreadId)}`;

/** The people of the switch: connected mailboxes the viewer may see, without the hold calendar owner (not a person). */
export function peopleFor(db, business, user, scope) {
  const own = ownMailboxId(db, business.id, user.email);
  return db.prepare("SELECT id, address FROM mailboxes WHERE business_id = ? AND status = 'connected' ORDER BY address").all(business.id)
    .filter((m) => canSee(scope, m.id) && m.id !== business.hold_calendar_owner_mailbox_id)
    .map((m) => ({
      mailboxId: m.id, address: m.address, own: m.id === own,
      name: db.prepare('SELECT name FROM users WHERE business_id = ? AND lower(email) = lower(?)').get(business.id, m.address)?.name || local(m.address),
    }));
}

const overlaps = (r, from, to) => (!to || r.start_utc < to) && (!from || (r.end_utc ?? r.start_utc) > from);
const endOf = (s) => s.end_utc ?? new Date(Date.parse(s.start_utc) + 30 * 60_000).toISOString(); // D38

/**
 * GET /api/calendar. view: 'team' | 'person:<mailboxId>' (default: the viewer's own mailbox, D39; team when
 * there is none, §8.3). → { view, timezone, people, events, negotiations, deadlines, sync } or { error } with a status.
 */
export function calendarView(db, { business, user, scope, from, to, view, now = new Date() }) {
  const people = peopleFor(db, business, user, scope);
  const visible = new Set(people.map((p) => p.mailboxId));
  const ownId = people.find((p) => p.own)?.mailboxId ?? null;
  let v = view || (ownId ? `person:${ownId}` : 'team');
  let only = null;
  if (v.startsWith('person:')) {
    only = v.slice(7);
    if (!canSee(scope, only)) return { status: 403, error: 'not your mailbox' };
    if (!visible.has(only)) return { status: 404, error: 'no such person' };
  } else v = 'team';
  const inView = (mailboxId) => (only ? mailboxId === only : visible.has(mailboxId));
  const threads = new Map();
  const threadOf = (id) => {
    if (!id) return null;
    if (!threads.has(id)) threads.set(id, db.prepare('SELECT id, cache_subject FROM threads WHERE id = ? AND business_id = ?').get(id, business.id) ?? null);
    return threads.get(id);
  };
  const addr = new Map(people.map((p) => [p.mailboxId, p.address]));
  const links = (mailboxId, threadId, gmailThreadId) => ({
    threadId: threadOf(threadId)?.id ?? null,
    gmailUrl: !threadOf(threadId) && gmailThreadId && addr.get(mailboxId) ? gmailUrl(addr.get(mailboxId), gmailThreadId) : null,
  });

  const events = [];
  // Confirmed meetings (ours): from our rows, so they show the moment they are confirmed.
  for (const m of db.prepare("SELECT * FROM meetings WHERE business_id = ? AND state = 'confirmed' AND google_event_id IS NOT NULL").all(business.id)) {
    if (!inView(m.mailbox_id) || !overlaps(m, from, to)) continue;
    const firstSuggestion = db.prepare('SELECT gmail_thread_id FROM suggestions WHERE meeting_id = ? LIMIT 1').get(m.id);
    events.push({ id: `m:${m.id}`, meetingId: m.id, mailboxId: m.mailbox_id, kind: 'meeting', start: m.start_utc, end: m.end_utc, allDay: false, title: m.title,
      location: m.place, meetUrl: m.link_url, attendees: JSON.parse(m.invite_state === 'sent' ? m.invite_attendees_json ?? '[]' : '[]').map((email) => ({ email, response: 'needsAction' })),
      suggestionId: null, pendingChange: Boolean(m.pending_change_suggestion_id), ...links(m.mailbox_id, m.thread_id, firstSuggestion?.gmail_thread_id) });
  }
  // 仮 holds (D28): on the 調整中 calendar, shown in the colour of the mailbox whose thread they belong to.
  for (const h of db.prepare(`SELECT h.id, s.mailbox_id, s.start_utc, s.end_utc, s.counterpart_label, s.thread_id, s.gmail_thread_id, s.id AS suggestion_id
      FROM holds h JOIN suggestions s ON s.id = h.suggestion_id WHERE h.business_id = ? AND h.state IN ('active','flagged') AND h.google_event_id IS NOT NULL`).all(business.id)) {
    if (!inView(h.mailbox_id) || !overlaps({ ...h, end_utc: endOf(h) }, from, to)) continue;
    events.push({ id: `h:${h.id}`, mailboxId: h.mailbox_id, kind: 'hold', start: h.start_utc, end: endOf(h), allDay: false, title: `仮: ${h.counterpart_label ?? ''}`.trim(),
      location: null, meetUrl: null, attendees: [], suggestionId: h.suggestion_id, ...links(h.mailbox_id, h.thread_id, h.gmail_thread_id) });
  }
  // AI-found dates not held yet (D1, D3): inbox-only, never in Google.
  const open = db.prepare("SELECT * FROM suggestions WHERE business_id = ? AND state IN ('suggested','held') AND kind IN ('offer','confirm') ORDER BY start_utc").all(business.id)
    .filter((s) => visible.has(s.mailbox_id));
  for (const s of open) {
    if (s.state !== 'suggested' || !inView(s.mailbox_id) || !overlaps({ ...s, end_utc: endOf(s) }, from, to)) continue;
    events.push({ id: `s:${s.id}`, mailboxId: s.mailbox_id, kind: 'suggested', start: s.start_utc, end: endOf(s), allDay: false,
      title: s.counterpart_label ?? '', location: null, meetUrl: null, attendees: [], suggestionId: s.id, ...links(s.mailbox_id, s.thread_id, s.gmail_thread_id) });
  }
  // Everything else on the people's own calendars, from the read cache, private fields stripped per viewer.
  const cached = db.prepare(`SELECT * FROM calendar_events WHERE business_id = ? AND mailbox_id IS NOT NULL AND ours_tag IS NULL
      AND (status IS NULL OR status != 'cancelled') AND start_utc < ? AND end_utc > ? ORDER BY start_utc`)
    .all(business.id, to ?? '9999', from ?? '0000').filter((r) => inView(r.mailbox_id));
  for (const e of eventsForViewer(cached, { ownMailboxId: ownId })) {
    if (e.busy) { events.push({ id: `c:${e.id}`, mailboxId: e.mailbox_id, kind: 'busy', start: e.start_utc, end: e.end_utc, allDay: Boolean(e.all_day) }); continue; }
    events.push({ id: `c:${e.id}`, mailboxId: e.mailbox_id, kind: 'meeting', start: e.start_utc, end: e.end_utc, allDay: Boolean(e.all_day), title: e.title ?? '',
      location: e.location, meetUrl: e.meet_url, attendees: [], suggestionId: null, threadId: null, gmailUrl: null });
  }
  // 締切 (D56): confirmed, open deadlines as all-day items on their due date; overdue ones stay in the panel.
  const tz = business.timezone || 'Asia/Tokyo';
  const today = todayIn(tz, now);
  const deadlines = openDeadlines(db, business.id).filter((d) => inView(d.mailbox_id)).map((d) => ({ ...deadlineView(d, tz, today), ...links(d.mailbox_id, d.thread_id, d.gmail_thread_id) }));
  for (const d of deadlines) {
    if (!overlaps({ start_utc: d.start, end_utc: d.end }, from, to)) continue;
    events.push({ id: `d:${d.id}`, deadlineId: d.id, deadlineType: d.type, mailboxId: d.mailboxId, kind: 'deadline', start: d.start, end: d.end, allDay: true,
      title: d.client, location: null, meetUrl: null, attendees: [], suggestionId: null, overdue: d.overdue, threadId: d.threadId, gmailUrl: d.gmailUrl });
  }
  events.sort((a, b) => a.start.localeCompare(b.start));

  // The 調整中 panel: every thread with open dates, our offers and theirs (D14).
  const groups = new Map();
  for (const s of open) {
    if (!inView(s.mailbox_id) || Date.parse(s.start_utc) <= now.getTime()) continue;
    const key = `${s.mailbox_id}|${s.gmail_thread_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const negotiations = [...groups.entries()].map(([key, rows]) => {
    const latest = rows.reduce((a, b) => ((b.message_at ?? '') > (a.message_at ?? '') ? b : a));
    const ours = latest.direction === 'ours';
    const anyHeld = rows.some((r) => r.state === 'held');
    const firstOpen = rows.find((r) => r.state === 'suggested');
    return {
      id: key, mailboxId: latest.mailbox_id, subject: threadOf(latest.thread_id)?.cache_subject ?? '', counterpart: latest.counterpart_label ?? '',
      direction: latest.direction, state: ours ? 'offered' : anyHeld ? 'held' : 'suggested', suggestionId: firstOpen?.id ?? null,
      suggestionIds: rows.filter((r) => r.state === 'suggested').map((r) => r.id),
      offers: rows.map((r) => ({ start: r.start_utc, end: endOf(r), state: r.state === 'held' ? 'held' : ours ? 'offered' : 'suggested', suggestionId: r.id })),
      updatedAt: latest.message_at ?? latest.created_at, ...links(latest.mailbox_id, latest.thread_id, latest.gmail_thread_id),
    };
  }).sort((a, b) => a.offers[0].start.localeCompare(b.offers[0].start));

  return { view: v, timezone: tz, people, events, negotiations, deadlines, sync: syncHealth(db, business, visible) };
}

/** Sync health for the header (Build details): every calendar the view reads, plus failed writes of the last day. */
export function syncHealth(db, business, visible) {
  const rows = db.prepare('SELECT * FROM calendar_sync WHERE business_id = ?').all(business.id).filter((r) => r.mailbox_id == null || visible.has(r.mailbox_id));
  const failed = db.prepare("SELECT last_error FROM calendar_writes WHERE business_id = ? AND status = 'failed' AND created_at > ? ORDER BY created_at DESC LIMIT 1")
    .get(business.id, new Date(Date.now() - 86_400_000).toISOString());
  const bad = rows.find((r) => r.error_count > 0);
  const times = rows.map((r) => r.last_ok_at).filter(Boolean).sort();
  return { ok: rows.length > 0 && !bad && !failed, lastAt: times[0] ?? null, error: bad?.last_error ?? failed?.last_error ?? (rows.length ? null : 'not synced yet') };
}

/**
 * The thread card (step 16): open dates on this thread, its confirmed meeting and a pending change.
 * The caller has checked the viewer may see the thread. → null when there is nothing to show.
 */
export function threadScheduling(db, { business, thread, mailLink = null }) {
  const tz = business.timezone || 'Asia/Tokyo';
  const meeting = db.prepare(`SELECT * FROM meetings WHERE business_id = ? AND state = 'confirmed' AND google_event_id IS NOT NULL AND (thread_id = ?
      OR id IN (SELECT meeting_id FROM suggestions WHERE mailbox_id = ? AND gmail_thread_id = ? AND meeting_id IS NOT NULL)) ORDER BY start_utc DESC LIMIT 1`)
    .get(business.id, thread.id, thread.mailbox_id, thread.gmail_thread_id);
  const open = db.prepare(`SELECT * FROM suggestions WHERE business_id = ? AND mailbox_id = ? AND gmail_thread_id = ? AND state IN ('suggested','held')
      AND kind IN ('offer','confirm') AND start_utc > ? ORDER BY start_utc`).all(business.id, thread.mailbox_id, thread.gmail_thread_id, new Date().toISOString());
  const change = meeting?.pending_change_suggestion_id ? db.prepare('SELECT * FROM suggestions WHERE id = ?').get(meeting.pending_change_suggestion_id) : null;
  if (!meeting && !open.length) return null;
  const latest = open.reduce((a, b) => (!a || (b.message_at ?? '') > (a.message_at ?? '') ? b : a), null);
  return {
    timezone: tz, direction: latest?.direction ?? 'theirs', source: latest?.source ?? 'ai', statedTz: latest?.stated_tz ?? null, meetUrl: mailLink,
    suggestionId: open.find((s) => s.state === 'suggested')?.id ?? open[0]?.id ?? null,
    offers: open.map((s) => ({ start: s.start_utc, end: endOf(s), state: s.state === 'held' ? 'held' : s.direction === 'ours' ? 'offered' : 'suggested', suggestionId: s.id })),
    meeting: meeting ? {
      id: meeting.id, start: meeting.start_utc, end: meeting.end_utc, meetUrl: meeting.link_url, location: meeting.place, conference: meeting.conference_status,
      invite: meeting.invite_state,
    } : null,
    change: change ? { kind: change.kind, start: change.start_utc, end: endOf(change), suggestionId: change.id } : null,
  };
}
