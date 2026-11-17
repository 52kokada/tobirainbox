// Calendar plan step 18: Tobira Manager endpoints (D5, D12, D17, D31, D32, D33).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { undoTokenHash } from '../src/routes/manager.js';
import { fakeGoogle } from './fake-calendar.js';

const masterKey = randomBytes(32).toString('base64');
const ADMIN = 'admin-token-very-secret-1234567890';
const DAY = 86_400_000;
const START = new Date(Date.now() + 3 * DAY); START.setUTCHours(1, 0, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

let db; let biz; let other; let leo; let info; let g; let config;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); other = newId(); leo = newId(); info = newId();
  config = { clientId: 'c', clientSecret: 's', masterKey, adminToken: ADMIN, managerBusinessId: biz, publicUrl: 'https://inbox.example.com' };
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode, hold_calendar_id, shadow_calendar_id) VALUES (?, 'Tobira', 'active', 'delegated', 'shadow', 'hold@group', 'shadow@group')").run(biz);
  db.prepare("INSERT INTO businesses (id, name, status, calendar_mode) VALUES (?, 'Other', 'active', 'on')").run(other);
  const m = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, ?, ?, 'connected', 'live', 0)");
  m.run(leo, biz, 'leo@example.com', encrypt('r', masterKey)); m.run(info, biz, 'info@example.com', encrypt('r', masterKey));
  db.prepare('UPDATE businesses SET hold_calendar_owner_mailbox_id = ? WHERE id = ?').run(info, biz);
  g = fakeGoogle();
});

const app = () => buildApp({ db, config, calendarClientFor: g.clientFor, meetWait: { wait: async () => {} } });
const call = (a, method, url, payload, token = ADMIN) => a.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload ? { payload } : {}) });
const add = (a, extra = {}) => call(a, 'POST', '/api/manager/meetings', { confirmer: 'gus#1234', mailbox: 'leo@example.com', start: iso(START.getTime()), title: 'Acme 打ち合わせ', idemKey: 'disc-1', ...extra });
const tokenOf = (url) => new URL(url).pathname.split('/').pop();
const undoLink = (a, token, meeting) => a.inject({ method: 'POST', url: `/m/undo/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: meeting ? `meeting=${meeting}` : '' });

test('wrong token 403, other business 403, no config 404, mode off 404', async () => {
  const a = app();
  assert.equal((await call(a, 'GET', '/api/manager/calendar', null, 'nope')).statusCode, 403);
  assert.equal((await call(a, 'GET', '/api/manager/calendar', null, null)).statusCode, 403);
  assert.equal((await call(a, 'GET', `/api/manager/calendar?business=${other}`)).statusCode, 403);
  assert.equal((await add(a, { business: other })).statusCode, 403);
  assert.equal((await call(a, 'GET', '/api/manager/calendar')).statusCode, 200);
  db.prepare("UPDATE businesses SET calendar_mode = 'off' WHERE id = ?").run(biz);
  assert.equal((await call(a, 'GET', '/api/manager/calendar')).statusCode, 404);
  config.managerBusinessId = '';
  assert.equal((await call(app(), 'GET', '/api/manager/calendar')).statusCode, 404);
});

test('chat addition writes to the shadow calendar only, records the confirmer, same idem key = same meeting', async () => {
  const a = app();
  const r = await add(a);
  assert.equal(r.statusCode, 201, r.body);
  const out = r.json();
  assert.equal(out.meeting.confirmedBy, 'gus#1234');
  assert.equal(out.meeting.via, 'manager');
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(out.meeting.id);
  assert.equal(row.confirmed_via, 'manager'); assert.equal(row.confirmed_by_label, 'gus#1234'); assert.equal(row.confirmed_by_user_id, null);
  assert.equal(row.google_calendar_id, 'shadow@group');
  const inserts = g.calls.filter((c) => c.method === 'POST' && !c.freeBusy);
  assert.equal(inserts.length, 1); assert.equal(inserts[0].calId, 'shadow@group');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'manager_meeting_confirmed' AND target = ? AND detail LIKE '%gus%'").get(row.id));
  const again = await add(a);
  assert.equal(again.statusCode, 200); assert.equal(again.json().meeting.id, out.meeting.id); assert.equal(again.json().created, false);
  assert.equal(g.calls.filter((c) => c.method === 'POST' && !c.freeBusy).length, 1);
  assert.equal((await add(a, { confirmer: '' })).statusCode, 400);
  assert.equal((await add(a, { mailbox: 'nobody@x.jp', idemKey: 'd2' })).statusCode, 400);
  assert.equal((await add(a, { start: iso(Date.now() - DAY), idemKey: 'd3' })).statusCode, 409);
});

test('board lists upcoming meetings, holds and suggestions in the next 14 days; private events busy-only', async () => {
  const a = app();
  const m = (await add(a)).json().meeting;
  const sug = (start, state) => {
    const id = newId();
    db.prepare(`INSERT INTO suggestions (id, business_id, mailbox_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, kind, counterpart_label, state, created_at)
      VALUES (?, ?, ?, 'GT', ?, 'ours', 'ai', ?, 'offer', 'Beta', ?, ?)`).run(id, biz, leo, `m-${id}`, start, state, iso(Date.now()));
    return id;
  };
  const held = sug(iso(START.getTime() + DAY), 'held');
  db.prepare("INSERT INTO holds (id, business_id, suggestion_id, google_calendar_id, state) VALUES (?, ?, ?, 'hold@group', 'active')").run(newId(), biz, held);
  sug(iso(START.getTime() + 2 * DAY), 'suggested');
  sug(iso(Date.now() + 20 * DAY), 'suggested');
  const ev = db.prepare(`INSERT INTO calendar_events (business_id, mailbox_id, google_calendar_id, google_event_id, start_utc, end_utc, title, visibility, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`);
  ev.run(biz, leo, 'leo@example.com', 'e1', iso(START.getTime() + 3 * DAY), iso(START.getTime() + 3 * DAY + 3600_000), '歯医者', 'private');
  ev.run(biz, leo, 'leo@example.com', 'e2', iso(START.getTime() + 4 * DAY), iso(START.getTime() + 4 * DAY + 3600_000), '定例', 'default');
  const b = (await call(a, 'GET', '/api/manager/calendar')).json();
  assert.equal(b.mode, 'shadow');
  assert.deepEqual(b.meetings.map((x) => x.id), [m.id]);
  assert.equal(b.meetings[0].mailbox, 'leo@example.com');
  assert.equal(b.holds.length, 1); assert.equal(b.holds[0].who, 'Beta');
  assert.equal(b.suggestions.length, 1);
  assert.equal(b.events.length, 2);
  const priv = b.events.find((e) => e.busy);
  assert.equal(priv.title, null); assert.ok(!JSON.stringify(b).includes('歯医者'));
  assert.equal((await call(a, 'GET', '/api/manager/calendar?from=2026-01-01&to=2027-01-01')).statusCode, 400);
});

test('undo link: confirm page on GET, works once, fails the second time, after expiry and for another meeting', async () => {
  const a = app();
  const one = (await add(a)).json();
  const two = (await add(a, { idemKey: 'disc-2', start: iso(START.getTime() + DAY) })).json();
  assert.ok(one.undoUrl.startsWith('https://inbox.example.com/m/undo/'));
  const t1 = tokenOf(one.undoUrl); const t2 = tokenOf(two.undoUrl);
  assert.ok(!db.prepare('SELECT 1 FROM manager_undo_tokens WHERE token_hash = ?').get(t1), 'only the hash is stored');
  const page = await a.inject(`/m/undo/${t1}`);
  assert.equal(page.statusCode, 200); assert.match(page.body, /<form method="post"/);
  assert.equal(db.prepare('SELECT state FROM meetings WHERE id = ?').get(one.meeting.id).state, 'confirmed', 'GET changes nothing');
  // Token of meeting two cannot undo meeting one.
  assert.equal((await undoLink(a, t2, one.meeting.id)).statusCode, 410);
  assert.equal(db.prepare('SELECT state FROM meetings WHERE id = ?').get(one.meeting.id).state, 'confirmed');
  const ok = await undoLink(a, t1, one.meeting.id);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(db.prepare('SELECT state FROM meetings WHERE id = ?').get(one.meeting.id).state, 'undone');
  assert.ok(g.calls.some((c) => c.method === 'DELETE' && c.calId === 'shadow@group'));
  assert.equal((await undoLink(a, t1, one.meeting.id)).statusCode, 410);
  assert.equal((await a.inject(`/m/undo/${t1}`)).statusCode, 410);
  db.prepare('UPDATE manager_undo_tokens SET expires_at = ? WHERE token_hash = ?').run(iso(Date.now() - 1000), undoTokenHash(t2, masterKey));
  assert.equal((await undoLink(a, t2, two.meeting.id)).statusCode, 410);
  assert.equal(db.prepare('SELECT state FROM meetings WHERE id = ?').get(two.meeting.id).state, 'confirmed');
  assert.equal((await undoLink(a, 'x'.repeat(43))).statusCode, 410);
});

test('API undo with the admin token; responses never carry ADMIN_TOKEN', async () => {
  const a = app();
  const one = await add(a);
  const u = await call(a, 'POST', `/api/manager/meetings/${one.json().meeting.id}/undo`, { confirmer: 'gus' });
  assert.equal(u.statusCode, 200); assert.equal(u.json().meeting.state, 'undone');
  assert.equal((await call(a, 'POST', '/api/manager/meetings/nope/undo', {})).statusCode, 404);
  const board = await call(a, 'GET', '/api/manager/calendar');
  for (const r of [one, u, board]) assert.ok(!r.body.includes(ADMIN), 'no admin token in responses');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_log').all()).includes(ADMIN));
});
