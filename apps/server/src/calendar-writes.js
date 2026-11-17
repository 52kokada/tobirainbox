// apps/server/src/calendar-writes.js — the one path for every Google Calendar write (plan step 10).
// Console, Manager and the worker all write through here (Build details: one route, idempotent).
//
//  - Each call takes an idem_key. The Google event id is derived from it (base32hex of a SHA-256, 26
//    chars, valid per the Calendar id rules), a calendar_writes row is written first, and the insert
//    uses that id. A 409 for the same id reads the existing event back instead of making a second one,
//    so a retry after a lost response never duplicates an event.
//  - Every event we write carries extendedProperties.private { tobiraInbox, tbiKind, tbiId, tbiBusiness }.
//    Patches and deletes read the event first and refuse one without our tag or with another tbiId, and
//    send If-Match with the etag we stored, so a hand edit in Google is never overwritten (D26).
//  - After every insert or patch the returned etag is stored on our row, so our own patch never looks
//    like a hand edit to the cleanup pass.
//  - Every call passes sendUpdates explicitly: 'none' everywhere except sending or cancelling an invite.
//  - Holds never carry attendees (Build details). Confirmed meetings carry none until an invite is sent.
//  - calendar_mode 'off' refuses every write. In 'shadow' every target calendar is replaced by the
//    business's shadow_calendar_id, written as the hold calendar owner (fail closed when either is missing).
import { createHash } from 'node:crypto';
import { CalendarError } from './calendar.js';
import { newId } from './store.js';

export class CalendarWriteError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

/** Google event id for an idem key: 26 base32hex chars (a-v, 0-9) of SHA-256(idem_key). */
export function eventIdFor(idemKey) {
  const bytes = createHash('sha256').update(String(idemKey)).digest();
  let bits = 0; let value = 0; let out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5 && out.length < 26) { out += BASE32HEX[(value >>> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= 26) break;
  }
  return out;
}

/** The hidden tag on every event we write (Build details). */
export const ourTag = ({ kind, id, businessId }) => ({ tobiraInbox: '1', tbiKind: kind, tbiId: id, tbiBusiness: businessId });

/** True only when the event carries our tag and it names this row (and business, when given). */
export function isOurs(event, { id, kind, businessId } = {}) {
  const t = event?.extendedProperties?.private;
  if (!t || t.tobiraInbox !== '1') return false;
  if (id != null && t.tbiId !== id) return false;
  if (kind != null && t.tbiKind !== kind) return false;
  if (businessId != null && t.tbiBusiness !== businessId) return false;
  return true;
}

/** A Google event differs from the one we last wrote (hand edit, D26). Cleanup flags these, never deletes. */
export const handEdited = (row, event) => Boolean(row?.etag && event?.etag && row.etag !== event.etag);

/**
 * Where a write goes. off: refused. shadow: the shadow calendar, as the hold calendar owner. on: the given
 * calendar as the given mailbox. → { client, calendarId, shadow }
 */
export function writeTarget(db, businessId, { mailbox, calendarId }, clientFor) {
  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!b) throw new CalendarWriteError('no_business');
  if (b.calendar_mode === 'off') throw new CalendarWriteError('calendar_off', 'calendar_mode is off: no Google writes');
  if (b.calendar_mode === 'shadow') {
    if (!b.shadow_calendar_id) throw new CalendarWriteError('no_shadow_calendar', 'shadow mode needs shadow_calendar_id');
    const owner = b.hold_calendar_owner_mailbox_id
      && db.prepare("SELECT * FROM mailboxes WHERE id = ? AND business_id = ? AND status = 'connected'").get(b.hold_calendar_owner_mailbox_id, businessId);
    if (!owner) throw new CalendarWriteError('owner_unavailable', 'shadow writes go as the hold calendar owner, which is not connected');
    return { client: clientFor(owner), calendarId: b.shadow_calendar_id, shadow: true };
  }
  if (!mailbox || mailbox.business_id !== businessId) throw new CalendarWriteError('bad_mailbox');
  if (!calendarId) throw new CalendarWriteError('no_calendar');
  return { client: clientFor(mailbox), calendarId, shadow: false };
}

const SEND_UPDATES = new Set(['none', 'all', 'externalOnly']);
function checkSendUpdates(v) {
  if (!SEND_UPDATES.has(v)) throw new CalendarWriteError('send_updates_required', 'sendUpdates must be given explicitly');
  return v;
}

/** The calendar_writes row for an idem key, created pending on first use. */
function writeRow(db, { businessId, kind, targetId, idemKey, eventId }) {
  db.prepare(`INSERT OR IGNORE INTO calendar_writes (id, business_id, kind, target_id, idem_key, google_event_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(newId(), businessId, kind, targetId, idemKey, eventId);
  const row = db.prepare('SELECT * FROM calendar_writes WHERE idem_key = ?').get(idemKey);
  if (row.business_id !== businessId || row.kind !== kind) throw new CalendarWriteError('idem_conflict', 'idem key used for another write');
  return row;
}
const finish = (db, row, status, error = null) => db.prepare('UPDATE calendar_writes SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?')
  .run(status, error ? String(error).slice(0, 500) : null, row.id);

const TABLES = { hold: 'holds', meeting: 'meetings' };
function storeEvent(db, kind, id, { calendarId, event }) {
  db.prepare(`UPDATE ${TABLES[kind]} SET google_calendar_id = ?, google_event_id = ?, etag = ? WHERE id = ?`).run(calendarId, event.id, event.etag ?? null, id);
}

/**
 * Insert one tagged event, once per idem key. → the Google event (ours).
 * A 409 on our derived id means an earlier attempt reached Google: read it back (must be ours).
 */
async function insertOnce({ db, businessId, kind, rowId, idemKey, writeKind, target, body, sendUpdates, conference = false }) {
  const eventId = eventIdFor(idemKey);
  const w = writeRow(db, { businessId, kind: writeKind, targetId: rowId, idemKey, eventId });
  const full = { ...body, id: eventId, extendedProperties: { private: ourTag({ kind, id: rowId, businessId }) } };
  try {
    let ev;
    try { ev = await target.client.insertEvent(target.calendarId, full, { sendUpdates: checkSendUpdates(sendUpdates), conference }); }
    catch (err) {
      if (!(err instanceof CalendarError && err.status === 409)) throw err;
      ev = await target.client.getEvent(target.calendarId, eventId);
      if (!isOurs(ev, { id: rowId, businessId })) throw new CalendarWriteError('id_taken', 'event id exists and is not ours');
      if (ev.status === 'cancelled') throw new CalendarWriteError('id_deleted', 'event with this id was deleted; use a new idem key');
    }
    storeEvent(db, kind, rowId, { calendarId: target.calendarId, event: ev });
    finish(db, w, 'ok');
    return ev;
  } catch (err) { finish(db, w, 'failed', err.message); throw err; }
}

/** Read our event and check the tag; null when it is already gone. Throws on an untagged or foreign event. */
async function readOurs(target, eventId, { kind, rowId, businessId }) {
  let ev;
  try { ev = await target.client.getEvent(target.calendarId, eventId); }
  catch (err) { if (err instanceof CalendarError && (err.status === 404 || err.status === 410)) return null; throw err; }
  if (ev.status === 'cancelled') return null;
  if (!isOurs(ev, { id: rowId, kind, businessId })) throw new CalendarWriteError('not_ours', 'refusing to change an event without our tag');
  return ev;
}

/** Patch our event with If-Match on our stored etag. 412 = hand edit: refused, code 'hand_edited'. */
async function patchOurs({ db, businessId, kind, row, idemKey, writeKind, target, patch, sendUpdates }) {
  const w = writeRow(db, { businessId, kind: writeKind, targetId: row.id, idemKey, eventId: row.google_event_id });
  try {
    const ev = await readOurs(target, row.google_event_id, { kind, rowId: row.id, businessId });
    if (!ev) throw new CalendarWriteError('gone', 'event no longer exists');
    if (handEdited(row, ev)) throw new CalendarWriteError('hand_edited', 'event was edited in Google');
    let out;
    try { out = await target.client.patchEvent(target.calendarId, row.google_event_id, patch, { etag: row.etag, sendUpdates: checkSendUpdates(sendUpdates) }); }
    catch (err) { if (err instanceof CalendarError && err.status === 412) throw new CalendarWriteError('hand_edited', 'event was edited in Google'); throw err; }
    storeEvent(db, kind, row.id, { calendarId: target.calendarId, event: out });
    finish(db, w, 'ok');
    return out;
  } catch (err) { finish(db, w, 'failed', err.message); throw err; }
}

/** Delete our event with If-Match. Already gone counts as done. → { deleted: boolean } */
async function deleteOurs({ db, businessId, kind, row, idemKey, writeKind, target, sendUpdates }) {
  const w = writeRow(db, { businessId, kind: writeKind, targetId: row.id, idemKey, eventId: row.google_event_id });
  if (w.status === 'ok') return { deleted: false, already: true };
  try {
    if (!row.google_event_id) { finish(db, w, 'ok'); return { deleted: false }; }
    const ev = await readOurs(target, row.google_event_id, { kind, rowId: row.id, businessId });
    if (!ev) { finish(db, w, 'ok'); return { deleted: false }; }
    if (handEdited(row, ev)) throw new CalendarWriteError('hand_edited', 'event was edited in Google');
    try { await target.client.deleteEvent(target.calendarId, row.google_event_id, { etag: row.etag, sendUpdates: checkSendUpdates(sendUpdates) }); }
    catch (err) {
      if (err instanceof CalendarError && err.status === 412) throw new CalendarWriteError('hand_edited', 'event was edited in Google');
      if (!(err instanceof CalendarError && (err.status === 404 || err.status === 410))) throw err;
    }
    finish(db, w, 'ok');
    return { deleted: true };
  } catch (err) { finish(db, w, 'failed', err.message); throw err; }
}

/** The target for an existing row: the calendar it was written to (shadow mode still forces the shadow calendar). */
function rowTarget(db, businessId, row, mailbox, clientFor) {
  return writeTarget(db, businessId, { mailbox, calendarId: row.google_calendar_id }, clientFor);
}

const when = (iso) => ({ dateTime: new Date(iso).toISOString() });

// ---- holds (no attendees, ever) -----------------------------------------------------------------

/**
 * Where hold writes go (D28, D43): only the business's 調整中 calendar (its shadow twin in shadow mode),
 * and only as hold_calendar_owner_mailbox_id. A NULL owner, an owner that is not a connected mailbox, or
 * no calendar id fails closed: no hold lands on anyone's personal calendar. With calendarId (a release),
 * that calendar must be the business's hold or shadow calendar. allowOff is for bin/calendar-release.js
 * only (deleting our own tagged events is the rollback while the mode is off); placing never allows it.
 */
export function holdTarget(db, businessId, clientFor, { calendarId = null, allowOff = false } = {}) {
  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!b) throw new CalendarWriteError('no_business');
  if (b.calendar_mode === 'off' && !allowOff) throw new CalendarWriteError('calendar_off', 'calendar_mode is off: no Google writes');
  if (!b.hold_calendar_owner_mailbox_id) throw new CalendarWriteError('no_owner', 'hold_calendar_owner_mailbox_id is not set');
  const owner = db.prepare("SELECT * FROM mailboxes WHERE id = ? AND business_id = ? AND status = 'connected'").get(b.hold_calendar_owner_mailbox_id, businessId);
  if (!owner) throw new CalendarWriteError('owner_unavailable', 'the hold calendar owner is not a connected mailbox of this business');
  let id = calendarId;
  if (id == null) id = b.calendar_mode === 'shadow' ? b.shadow_calendar_id : b.hold_calendar_id;
  else if (id !== b.hold_calendar_id && id !== b.shadow_calendar_id) throw new CalendarWriteError('not_hold_calendar', 'holds live only on the 調整中 or shadow calendar');
  if (b.calendar_mode === 'shadow' && id !== b.shadow_calendar_id) throw new CalendarWriteError('not_shadow', 'shadow mode writes only to shadow_calendar_id');
  if (!id) throw new CalendarWriteError('no_hold_calendar', b.calendar_mode === 'shadow' ? 'shadow_calendar_id is not set' : 'hold_calendar_id is not set');
  return { client: clientFor(owner), calendarId: id, shadow: id === b.shadow_calendar_id, owner };
}

/** A 仮 hold on the 調整中 calendar as its owner. No attendees; sendUpdates 'none'. */
export async function placeHold({ db, businessId, hold, summary, startUtc, endUtc, clientFor }) {
  const target = holdTarget(db, businessId, clientFor);
  const body = { summary, start: when(startUtc), end: when(endUtc), transparency: 'opaque' };
  return insertOnce({ db, businessId, kind: 'hold', rowId: hold.id, idemKey: `hold:${hold.id}`, writeKind: 'hold_place', target, body, sendUpdates: 'none' });
}

export async function releaseHold({ db, businessId, hold, clientFor, reason = 'release', allowOff = false }) {
  if (!hold.google_event_id) return { deleted: false };
  const target = holdTarget(db, businessId, clientFor, { calendarId: hold.google_calendar_id, allowOff });
  return deleteOurs({ db, businessId, kind: 'hold', row: hold, idemKey: `hold:${hold.id}:${reason}`, writeKind: 'hold_release', target, sendUpdates: 'none' });
}

// ---- meetings -----------------------------------------------------------------------------------

/**
 * The confirmed meeting on the mailbox's own calendar (D27, D37): no attendees, sendUpdates 'none'.
 * conferenceRequestId asks Google for a Meet link (conferenceDataVersion=1).
 */
export async function confirmMeeting({ db, businessId, meeting, mailbox, calendarId, clientFor, description, conferenceRequestId }) {
  const target = writeTarget(db, businessId, { mailbox, calendarId: calendarId ?? mailbox?.address }, clientFor);
  const body = {
    summary: meeting.title ?? '', start: when(meeting.start_utc), end: when(meeting.end_utc),
    ...(meeting.place ? { location: meeting.place } : {}), ...(description ? { description } : {}),
    ...(conferenceRequestId ? { conferenceData: { createRequest: { requestId: conferenceRequestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
  };
  return insertOnce({ db, businessId, kind: 'meeting', rowId: meeting.id, idemKey: meeting.idem_key, writeKind: 'meeting_confirm', target, body, sendUpdates: 'none', conference: Boolean(conferenceRequestId) });
}

/** Attendees hear about a cancel only when an invite went out (step 14). */
const meetingUpdates = (meeting) => (meeting.invite_state === 'sent' ? 'all' : 'none');

export async function cancelMeeting({ db, businessId, meeting, mailbox, clientFor }) {
  const target = rowTarget(db, businessId, meeting, mailbox, clientFor);
  return deleteOurs({ db, businessId, kind: 'meeting', row: meeting, idemKey: `${meeting.idem_key}:cancel`, writeKind: 'meeting_cancel', target, sendUpdates: meetingUpdates(meeting) });
}

/** Undo a wrong confirm (D33): delete our event; sendUpdates 'none' unless an invite was sent. */
export async function undoConfirm({ db, businessId, meeting, mailbox, clientFor }) {
  const target = rowTarget(db, businessId, meeting, mailbox, clientFor);
  return deleteOurs({ db, businessId, kind: 'meeting', row: meeting, idemKey: `${meeting.idem_key}:undo`, writeKind: 'meeting_undo', target, sendUpdates: meetingUpdates(meeting) });
}

/**
 * bin/calendar-release.js only: delete one meeting's tagged event, telling nobody (sendUpdates 'none').
 * A meeting on the shadow calendar is deleted as the hold calendar owner; otherwise as its mailbox.
 */
export async function releaseMeeting({ db, businessId, meeting, clientFor, allowOff = false }) {
  if (!meeting.google_event_id) return { deleted: false };
  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (b.calendar_mode === 'off' && !allowOff) throw new CalendarWriteError('calendar_off');
  let target;
  if (meeting.google_calendar_id && meeting.google_calendar_id === b.shadow_calendar_id) {
    target = holdTarget(db, businessId, clientFor, { calendarId: meeting.google_calendar_id, allowOff: true });
  } else {
    if (b.calendar_mode === 'shadow') throw new CalendarWriteError('not_shadow', 'shadow mode writes only to shadow_calendar_id');
    const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND business_id = ?').get(meeting.mailbox_id, businessId);
    if (!mailbox) throw new CalendarWriteError('bad_mailbox');
    target = { client: clientFor(mailbox), calendarId: meeting.google_calendar_id, shadow: false };
  }
  return deleteOurs({ db, businessId, kind: 'meeting', row: meeting, idemKey: `${meeting.idem_key}:release`, writeKind: 'meeting_release', target, sendUpdates: 'none' });
}

/** Move a meeting (step 14) with the stored etag. */
export async function moveMeeting({ db, businessId, meeting, mailbox, clientFor, startUtc, endUtc, idemKey }) {
  const target = rowTarget(db, businessId, meeting, mailbox, clientFor);
  return patchOurs({ db, businessId, kind: 'meeting', row: meeting, idemKey, writeKind: 'meeting_move', target,
    patch: { start: when(startUtc), end: when(endUtc) }, sendUpdates: meetingUpdates(meeting) });
}

// ---- invites (D41, D50: sent on the confirmation email's real delivery) -------------------------

/** No Google call: the attendees wait on the row until the email is delivered (step 15). */
export function queueInvite(db, { businessId, meetingId, attendees }) {
  const list = [...new Set((attendees ?? []).map((a) => String(a).trim().toLowerCase()).filter((a) => /^[^\s@]+@[^\s@]+$/.test(a)))];
  if (!list.length) throw new CalendarWriteError('no_attendees');
  const r = db.prepare("UPDATE meetings SET invite_attendees_json = ?, invite_state = 'queued' WHERE id = ? AND business_id = ? AND invite_state IN ('none','queued','cancelled')")
    .run(JSON.stringify(list), meetingId, businessId);
  if (!r.changes) throw new CalendarWriteError('not_queueable');
  return list;
}

export async function sendInvite({ db, businessId, meeting, mailbox, clientFor }) {
  if (meeting.invite_state === 'sent') return { already: true };
  if (meeting.invite_state !== 'queued') throw new CalendarWriteError('not_queued');
  const attendees = JSON.parse(meeting.invite_attendees_json ?? '[]').map((email) => ({ email }));
  const target = rowTarget(db, businessId, meeting, mailbox, clientFor);
  const ev = await patchOurs({ db, businessId, kind: 'meeting', row: meeting, idemKey: `${meeting.idem_key}:invite`, writeKind: 'invite_send', target,
    patch: { attendees }, sendUpdates: 'all' });
  db.prepare("UPDATE meetings SET invite_state = 'sent', invite_sent_at = ? WHERE id = ?").run(new Date().toISOString(), meeting.id);
  return ev;
}

export async function cancelInvite({ db, businessId, meeting, mailbox, clientFor }) {
  if (meeting.invite_state === 'queued' || meeting.invite_state === 'none') {
    db.prepare("UPDATE meetings SET invite_state = 'none' WHERE id = ?").run(meeting.id);
    return { googleCall: false };
  }
  const target = rowTarget(db, businessId, meeting, mailbox, clientFor);
  const ev = await patchOurs({ db, businessId, kind: 'meeting', row: meeting, idemKey: `${meeting.idem_key}:invite-cancel`, writeKind: 'invite_cancel', target,
    patch: { attendees: [] }, sendUpdates: 'all' });
  db.prepare("UPDATE meetings SET invite_state = 'cancelled' WHERE id = ?").run(meeting.id);
  return ev;
}
