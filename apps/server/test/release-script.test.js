// Calendar plan step 11: bin/calendar-release.js — dry run by default, tagged and matching events only,
// explicit meeting ids, and --delete-calendar refuses while any untagged event remains.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { holdPass } from '../src/suggestions.js';
import { confirmMeeting } from '../src/calendar-writes.js';
import { release } from '../bin/calendar-release.js';
import { fakeGoogle } from './fake-calendar.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-11-08T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

let db; let biz; let leo; let info; let g;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); leo = newId(); info = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode, hold_calendar_id) VALUES (?, 'Tobira', 'active', 'delegated', 'on', 'hold@group')").run(biz);
  const m = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, ?, 'x', 'connected', 'live')");
  m.run(leo, biz, 'leo@example.com'); m.run(info, biz, 'info@example.com');
  db.prepare('UPDATE businesses SET hold_calendar_owner_mailbox_id = ? WHERE id = ?').run(info, biz);
  g = fakeGoogle();
});

async function twoHolds() {
  for (const [i, thread] of [[1, 'gt1'], [2, 'gt2']]) {
    db.prepare(`INSERT INTO suggestions (id, business_id, mailbox_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, kind, counterpart_label, message_at)
      VALUES (?, ?, ?, ?, ?, 'ours', 'ai', ?, 'offer', 'Acme', ?)`).run(newId(), biz, leo, thread, `m${i}`, iso(NOW.getTime() + i * DAY), iso(NOW.getTime()));
  }
  await holdPass({ db, businessId: biz, clientFor: g.clientFor, now: NOW });
  return db.prepare('SELECT * FROM holds ORDER BY expires_at').all();
}
const snapshot = () => JSON.stringify(['holds', 'meetings', 'calendar_writes', 'businesses', 'audit_log'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
const run = (o) => release({ db, businessId: biz, clientFor: g.clientFor, ...o });

test('dry run (the default) writes nothing to Google or the database', async () => {
  await twoHolds();
  const before = snapshot(); const writes = g.writes().length;
  const r = await run({ holds: true });
  assert.equal(r.apply, false);
  assert.equal(r.wouldDelete.length, 2);
  assert.equal(r.deleted.length, 0);
  assert.equal(g.writes().length, writes);
  assert.equal(snapshot(), before);
  assert.equal(g.cal('hold@group').size, 2);
});

test('--apply deletes only tagged events whose tbiId matches a hold row; untagged, mismatched and hand-edited are skipped', async () => {
  const [h1, h2] = await twoHolds();
  const cal = g.cal('hold@group');
  cal.set('mine', { id: 'mine', etag: '"p"', status: 'confirmed', summary: 'Leo dentist' });
  cal.set('fake', { id: 'fake', etag: '"f"', status: 'confirmed', summary: 'x', extendedProperties: { private: { tobiraInbox: '1', tbiKind: 'hold', tbiId: 'no-such-row', tbiBusiness: biz } } });
  g.handEdit('hold@group', h2.google_event_id);
  const r = await run({ holds: true, apply: true });
  assert.deepEqual(r.deleted.map((d) => d.holdId), [h1.id]);
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['edited in Google', 'no matching hold row', 'untagged']);
  assert.deepEqual([...cal.keys()].sort(), [h2.google_event_id, 'fake', 'mine'].sort());
  const del = g.calls.filter((c) => c.method === 'DELETE');
  assert.equal(del.length, 1);
  assert.equal(del[0].ifMatch, h1.etag);
  assert.equal(del[0].q.sendUpdates, 'none');
  assert.equal(db.prepare('SELECT state FROM holds WHERE id = ?').get(h1.id).state, 'removed');
});

test('release works with calendar_mode off (the rollback), and with --shadow targets only the shadow calendar', async () => {
  db.prepare("UPDATE businesses SET calendar_mode = 'shadow', shadow_calendar_id = 'shadow@group'").run();
  await twoHolds();
  g.cal('hold@group').set('real', { id: 'real', etag: '"r"', status: 'confirmed', extendedProperties: { private: { tobiraInbox: '1', tbiKind: 'hold', tbiId: 'x', tbiBusiness: biz } } });
  db.prepare("UPDATE businesses SET calendar_mode = 'off'").run();
  const r = await run({ holds: true, shadow: true, apply: true });
  assert.equal(r.deleted.length, 2);
  assert.equal(g.cal('shadow@group').size, 0);
  assert.equal(g.cal('hold@group').size, 1);
  assert.ok(g.calls.filter((c) => c.method !== 'GET').every((c) => c.calId === 'shadow@group'));
});

test('--meetings needs explicit ids and deletes only that meeting, telling nobody', async () => {
  await assert.rejects(run({ meetings: [] }), /explicit ids/);
  await assert.rejects(run({ meetings: ['all'] }), /explicit ids/);
  const ids = [newId(), newId()];
  for (const id of ids) {
    db.prepare(`INSERT INTO meetings (id, business_id, mailbox_id, start_utc, end_utc, title, confirmed_via, idem_key) VALUES (?, ?, ?, ?, ?, 'Acme', 'console', ?)`)
      .run(id, biz, leo, iso(NOW.getTime() + DAY), iso(NOW.getTime() + DAY + 1800_000), `confirm:${id}`);
    await confirmMeeting({ db, businessId: biz, meeting: db.prepare('SELECT * FROM meetings WHERE id = ?').get(id), mailbox: db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(leo), clientFor: g.clientFor });
  }
  const dry = await run({ meetings: [ids[0]] });
  assert.equal(dry.wouldDelete.length, 1);
  assert.equal(g.cal('leo@example.com').size, 2);
  const r = await run({ meetings: [ids[0], 'missing'], apply: true });
  assert.deepEqual(r.deleted.map((d) => d.meetingId), [ids[0]]);
  assert.equal(r.skipped[0].reason, 'no such meeting with an event');
  assert.equal(g.cal('leo@example.com').size, 1);
  assert.equal(g.calls.filter((c) => c.method === 'DELETE').at(-1).q.sendUpdates, 'none');
  assert.equal(db.prepare('SELECT state FROM meetings WHERE id = ?').get(ids[0]).state, 'cancelled');
});

test('--delete-calendar refuses while one untagged event remains, and deletes once only ours are left', async () => {
  await twoHolds();
  g.cal('hold@group').set('mine', { id: 'mine', etag: '"p"', status: 'confirmed', summary: 'added by hand' });
  const refused = await run({ deleteCalendar: true, apply: true });
  assert.match(refused.refused, /1 event/);
  assert.equal(g.calls.some((c) => c.method === 'DELETE' && !c.evId), false);
  assert.equal(db.prepare('SELECT hold_calendar_id AS c FROM businesses').get().c, 'hold@group');

  g.cal('hold@group').delete('mine');
  const dry = await run({ deleteCalendar: true });
  assert.equal(dry.wouldDeleteCalendar, 'hold@group');
  assert.equal(g.calls.some((c) => c.method === 'DELETE' && !c.evId), false);
  const r = await run({ holds: true, deleteCalendar: true, apply: true });
  assert.equal(r.calendarDeleted, 'hold@group');
  assert.equal(db.prepare('SELECT hold_calendar_id AS c FROM businesses').get().c, null);
});

test('the release script imports no send, outbox, ingest, mailbox or label module', () => {
  const source = readFileSync(join(HERE, '..', 'bin', 'calendar-release.js'), 'utf8');
  for (const mod of ['send-queue', 'cockpit-outbox', 'ingest', 'mailboxes', 'gmail', 'app.js', 'transport', 'suggestions']) {
    assert.ok(!source.includes(`/${mod}`), `imports ${mod}`);
  }
});
