// Calendar plan step 10: one write path for all Google writes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { Calendar } from '../src/calendar.js';
import {
  eventIdFor, isOurs, handEdited, placeHold, releaseHold, confirmMeeting, cancelMeeting, undoConfirm, moveMeeting,
  queueInvite, sendInvite, cancelInvite, writeTarget, CalendarWriteError,
} from '../src/calendar-writes.js';

/**
 * Fake Calendar REST API. Events per calendar; 409 on a duplicate id; If-Match checked (412); etag
 * changes on every write. `failAfter(op)` makes Google apply a write and then lose the response.
 */
function fakeGoogle() {
  const cals = new Map(); const calls = []; let n = 0; const loseResponse = new Set();
  const cal = (id) => { if (!cals.has(id)) cals.set(id, new Map()); return cals.get(id); };
  const res = (status, json) => ({ ok: status < 400, status, json: async () => json });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const [calId, , evId] = u.pathname.replace('/calendar/v3/calendars/', '').split('/').map(decodeURIComponent);
    const q = Object.fromEntries(u.searchParams);
    const ifMatch = init.headers['if-match'] ?? null;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, calId, evId, q, ifMatch, body });
    const events = cal(calId);
    if (init.method === 'POST') {
      if (events.has(body.id)) return res(409, { error: { message: 'The requested identifier already exists.' } });
      const ev = { ...body, status: 'confirmed', etag: `"e${++n}"` };
      events.set(body.id, ev);
      if (loseResponse.delete('insert')) throw new Error('socket hang up');
      return res(200, ev);
    }
    const ev = events.get(evId);
    if (!ev) return res(404, { error: { message: 'Not Found' } });
    if (init.method === 'GET') return res(200, ev);
    if (ifMatch && ifMatch !== ev.etag) return res(412, { error: { message: 'Precondition Failed' } });
    if (init.method === 'PATCH') { Object.assign(ev, body, { etag: `"e${++n}"` }); return res(200, ev); }
    if (init.method === 'DELETE') { events.delete(evId); return res(204, {}); }
    return res(400, {});
  };
  const client = new Calendar({ accessToken: async () => 'AT', fetchImpl });
  return { client, calls, cals, cal, handEdit: (calId, evId) => { const e = cal(calId).get(evId); e.summary = 'edited by hand'; e.etag = `"hand${++n}"`; }, loseNext: (op) => loseResponse.add(op) };
}

let db; let biz; let leo; let info; let g; let clientFor; let asked;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); leo = newId(); info = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode) VALUES (?, 'Tobira', 'active', 'delegated', 'on')").run(biz);
  const m = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, ?, 'enc', 'connected', 'live')");
  m.run(leo, biz, 'leo@example.com'); m.run(info, biz, 'info@example.com');
  db.prepare("UPDATE businesses SET hold_calendar_id = 'hold@group', hold_calendar_owner_mailbox_id = ?, shadow_calendar_id = 'shadow@group' WHERE id = ?").run(info, biz);
  g = fakeGoogle(); asked = [];
  clientFor = (mb) => { asked.push(mb.address); return g.client; };
});
const mbox = (id) => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id);
const setMode = (m) => db.prepare('UPDATE businesses SET calendar_mode = ? WHERE id = ?').run(m, biz);

function suggestionAndHold() {
  const sid = newId(); const hid = newId();
  db.prepare("INSERT INTO suggestions (id, business_id, mailbox_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, kind) VALUES (?, ?, ?, 'gt', 'gm', 'ours', 'ai', '2026-11-09T01:00:00.000Z', 'offer')").run(sid, biz, leo);
  db.prepare('INSERT INTO holds (id, business_id, suggestion_id) VALUES (?, ?, ?)').run(hid, biz, sid);
  return db.prepare('SELECT * FROM holds WHERE id = ?').get(hid);
}
function meeting(extra = {}) {
  const id = newId();
  db.prepare(`INSERT INTO meetings (id, business_id, mailbox_id, start_utc, end_utc, title, confirmed_via, idem_key) VALUES (?, ?, ?, '2026-11-09T01:00:00.000Z', '2026-11-09T01:30:00.000Z', 'Acme', 'console', ?)`)
    .run(id, biz, leo, extra.idem ?? `confirm:${id}`);
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}
const holdRow = (id) => db.prepare('SELECT * FROM holds WHERE id = ?').get(id);
const meetingRow = (id) => db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
const hold = (h) => placeHold({ db, businessId: biz, hold: h, mailbox: mbox(info), calendarId: 'hold@group', summary: '仮: Acme', startUtc: '2026-11-09T01:00:00Z', endUtc: '2026-11-09T01:30:00Z', clientFor });

test('event ids derived from idem keys are 26 base32hex chars and stable', () => {
  const a = eventIdFor('confirm:1');
  assert.match(a, /^[0-9a-v]{26}$/);
  assert.equal(a, eventIdFor('confirm:1'));
  assert.notEqual(a, eventIdFor('confirm:2'));
});

test('double submit gives one event (client-generated id; the second insert hits 409 and reads it back)', async () => {
  const m = meeting();
  const [a, b] = await Promise.all([
    confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor }),
    confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor }),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.id, eventIdFor(m.idem_key));
  assert.equal(g.cal('leo@example.com').size, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_writes').get().n, 1);
  const ins = g.calls.filter((c) => c.method === 'POST');
  assert.ok(ins.every((c) => c.body.id === a.id && c.q.sendUpdates === 'none' && !c.body.attendees));
});

test('network failure after Google succeeded, then retry: one event (409 path), write row ok, etag stored', async () => {
  const m = meeting();
  g.loseNext('insert');
  await assert.rejects(confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor }), /socket hang up/);
  assert.equal(db.prepare('SELECT status FROM calendar_writes').get().status, 'failed');
  const ev = await confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor });
  assert.equal(g.cal('leo@example.com').size, 1);
  const w = db.prepare('SELECT * FROM calendar_writes').get();
  assert.deepEqual([w.status, w.attempts, w.google_event_id], ['ok', 2, ev.id]);
  assert.equal(meetingRow(m.id).etag, ev.etag);
  assert.equal(meetingRow(m.id).google_event_id, ev.id);
});

test('a 409 on an event that is not ours is refused', async () => {
  const m = meeting();
  g.cal('leo@example.com').set(eventIdFor(m.idem_key), { id: eventIdFor(m.idem_key), etag: '"x"', status: 'confirmed', summary: 'someone else' });
  await assert.rejects(confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor }), (e) => e.code === 'id_taken');
});

test('untagged or mismatched-tbiId delete is refused; Google is not asked to delete', async () => {
  const h = suggestionAndHold();
  await hold(h);
  const row = holdRow(h.id);
  const ev = g.cal('hold@group').get(row.google_event_id);
  delete ev.extendedProperties;
  await assert.rejects(releaseHold({ db, businessId: biz, hold: row, mailbox: mbox(info), clientFor }), (e) => e.code === 'not_ours');
  ev.extendedProperties = { private: { tobiraInbox: '1', tbiKind: 'hold', tbiId: 'other-row', tbiBusiness: biz } };
  await assert.rejects(releaseHold({ db, businessId: biz, hold: row, mailbox: mbox(info), clientFor, reason: 'again' }), (e) => e.code === 'not_ours');
  assert.equal(g.calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(g.cal('hold@group').size, 1);
});

test('deletes and patches send If-Match with our etag; a hand edit is refused (412 or etag check), never overwritten', async () => {
  const h = suggestionAndHold();
  await hold(h);
  const row = holdRow(h.id);
  assert.ok(isOurs(g.cal('hold@group').get(row.google_event_id), { id: h.id, kind: 'hold', businessId: biz }));
  g.handEdit('hold@group', row.google_event_id);
  await assert.rejects(releaseHold({ db, businessId: biz, hold: row, mailbox: mbox(info), clientFor }), (e) => e.code === 'hand_edited');
  assert.equal(g.cal('hold@group').size, 1);

  const h2 = suggestionAndHold();
  await hold(h2);
  const r2 = holdRow(h2.id);
  await releaseHold({ db, businessId: biz, hold: r2, mailbox: mbox(info), clientFor });
  const del = g.calls.find((c) => c.method === 'DELETE');
  assert.equal(del.ifMatch, r2.etag);
  assert.equal(del.q.sendUpdates, 'none');
  // Releasing again is a no-op (idempotent per idem key).
  const again = await releaseHold({ db, businessId: biz, hold: r2, mailbox: mbox(info), clientFor });
  assert.equal(again.already, true);
});

test('etag is updated after our own patch, so a later cleanup check does not flag it', async () => {
  const m = meeting();
  await confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor });
  const before = meetingRow(m.id).etag;
  await moveMeeting({ db, businessId: biz, meeting: meetingRow(m.id), mailbox: mbox(leo), clientFor, startUtc: '2026-11-10T01:00:00Z', endUtc: '2026-11-10T01:30:00Z', idemKey: `move:${m.id}:1` });
  const after = meetingRow(m.id);
  assert.notEqual(after.etag, before);
  const patch = g.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.ifMatch, before);
  const live = g.cal('leo@example.com').get(after.google_event_id);
  assert.equal(handEdited(after, live), false);
  g.handEdit('leo@example.com', after.google_event_id);
  assert.equal(handEdited(after, g.cal('leo@example.com').get(after.google_event_id)), true);
});

test("sendUpdates is 'none' on every write except invite send and cancel ('all')", async () => {
  const h = suggestionAndHold();
  await hold(h);
  await releaseHold({ db, businessId: biz, hold: holdRow(h.id), mailbox: mbox(info), clientFor });
  const m = meeting();
  await confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor });
  await moveMeeting({ db, businessId: biz, meeting: meetingRow(m.id), mailbox: mbox(leo), clientFor, startUtc: '2026-11-10T01:00:00Z', endUtc: '2026-11-10T01:30:00Z', idemKey: 'mv1' });
  const nonInvite = g.calls.filter((c) => c.method !== 'GET');
  assert.ok(nonInvite.length >= 4);
  assert.ok(nonInvite.every((c) => c.q.sendUpdates === 'none'), JSON.stringify(nonInvite.map((c) => c.q)));

  queueInvite(db, { businessId: biz, meetingId: m.id, attendees: ['client@acme.co.jp'] });
  const mark = g.calls.length;
  await sendInvite({ db, businessId: biz, meeting: meetingRow(m.id), mailbox: mbox(leo), clientFor });
  await cancelInvite({ db, businessId: biz, meeting: meetingRow(m.id), mailbox: mbox(leo), clientFor });
  const inviteWrites = g.calls.slice(mark).filter((c) => c.method === 'PATCH');
  assert.deepEqual(inviteWrites.map((c) => c.q.sendUpdates), ['all', 'all']);
  assert.deepEqual(inviteWrites[0].body.attendees, [{ email: 'client@acme.co.jp' }]);
  assert.deepEqual(inviteWrites[1].body.attendees, []);
  assert.equal(meetingRow(m.id).invite_state, 'cancelled');

  // After a sent invite, cancel tells attendees; with no invite it does not.
  const m2 = meeting();
  await confirmMeeting({ db, businessId: biz, meeting: m2, mailbox: mbox(leo), clientFor });
  await undoConfirm({ db, businessId: biz, meeting: meetingRow(m2.id), mailbox: mbox(leo), clientFor });
  assert.equal(g.calls.at(-1).q.sendUpdates, 'none');
  const m3 = meeting();
  await confirmMeeting({ db, businessId: biz, meeting: m3, mailbox: mbox(leo), clientFor });
  queueInvite(db, { businessId: biz, meetingId: m3.id, attendees: ['client@acme.co.jp'] });
  await sendInvite({ db, businessId: biz, meeting: meetingRow(m3.id), mailbox: mbox(leo), clientFor });
  await cancelMeeting({ db, businessId: biz, meeting: meetingRow(m3.id), mailbox: mbox(leo), clientFor });
  assert.equal(g.calls.at(-1).method, 'DELETE');
  assert.equal(g.calls.at(-1).q.sendUpdates, 'all');
});

test('queueInvite makes no Google call; a queued invite cancelled before delivery makes none either', async () => {
  const m = meeting();
  await confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor });
  const mark = g.calls.length;
  queueInvite(db, { businessId: biz, meetingId: m.id, attendees: ['A@acme.co.jp', 'a@acme.co.jp', 'not an address'] });
  assert.deepEqual(JSON.parse(meetingRow(m.id).invite_attendees_json), ['a@acme.co.jp']);
  const r = await cancelInvite({ db, businessId: biz, meeting: meetingRow(m.id), mailbox: mbox(leo), clientFor });
  assert.equal(r.googleCall, false);
  assert.equal(meetingRow(m.id).invite_state, 'none');
  assert.equal(g.calls.length, mark);
});

test('shadow mode never writes to a non-shadow calendar id, and writes as the hold calendar owner', async () => {
  setMode('shadow');
  const h = suggestionAndHold();
  await hold(h);
  const m = meeting();
  await confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor });
  await undoConfirm({ db, businessId: biz, meeting: meetingRow(m.id), mailbox: mbox(leo), clientFor });
  await releaseHold({ db, businessId: biz, hold: holdRow(h.id), mailbox: mbox(info), clientFor });
  assert.ok(g.calls.length >= 4);
  assert.ok(g.calls.every((c) => c.calId === 'shadow@group'), JSON.stringify(g.calls.map((c) => c.calId)));
  assert.ok(asked.every((a) => a === 'info@example.com'));
  assert.equal(holdRow(h.id).google_calendar_id, 'shadow@group');
  // Shadow with no shadow calendar fails closed.
  db.prepare('UPDATE businesses SET shadow_calendar_id = NULL WHERE id = ?').run(biz);
  assert.throws(() => writeTarget(db, biz, { mailbox: mbox(leo), calendarId: 'leo@example.com' }, clientFor), (e) => e.code === 'no_shadow_calendar');
});

test("calendar_mode 'off' refuses every write before any Google call", async () => {
  setMode('off');
  const h = suggestionAndHold();
  await assert.rejects(hold(h), (e) => e instanceof CalendarWriteError && e.code === 'calendar_off');
  const m = meeting();
  await assert.rejects(confirmMeeting({ db, businessId: biz, meeting: m, mailbox: mbox(leo), clientFor }), (e) => e.code === 'calendar_off');
  assert.equal(g.calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_writes').get().n, 0);
});
