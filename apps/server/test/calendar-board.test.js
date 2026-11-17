// Calendar plan steps 16-17: the thread card and GET /api/calendar. Shown only when calendar_mode is on
// (shadow: owners only, D45); limited to the viewer's mailboxes (D8); private events of another person's
// calendar reach the JSON as busy blocks with no title, location or link (D16, D34, D39).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { fakeGoogle } from './fake-calendar.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 5 };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const DAY = 86_400_000;
const T = Date.now() + 3 * DAY;
const iso = (ms) => new Date(ms).toISOString();
const FROM = iso(Date.now() - DAY); const TO = iso(Date.now() + 20 * DAY);

let db; let biz; let leo; let gus; let info; let thrK; let thrH; let g;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); leo = newId(); gus = newId(); info = newId(); thrK = newId(); thrH = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode, hold_calendar_id) VALUES (?, 'Tobira', 'active', 'delegated', 'on', 'hold@group')").run(biz);
  const m = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, ?, ?, 'connected', 'live', 0)");
  m.run(leo, biz, 'leo@example.com', encrypt('r', masterKey)); m.run(gus, biz, 'gus@example.com', encrypt('r', masterKey)); m.run(info, biz, 'info@example.com', encrypt('r', masterKey));
  db.prepare('UPDATE businesses SET hold_calendar_owner_mailbox_id = ? WHERE id = ?').run(info, biz);
  const u = db.prepare('INSERT INTO users (id, business_id, email, role) VALUES (?, ?, ?, ?)');
  u.run(newId(), biz, 'leo@example.com', 'owner'); u.run(newId(), biz, 'gus@example.com', 'staff');
  const p1 = newId(); const p2 = newId();
  u.run(p1, biz, 'p@partner.jp', 'partner'); u.run(p2, biz, 'ro@partner.jp', 'partner');
  db.prepare('INSERT INTO partner_mailboxes (user_id, business_id, mailbox_id, can_send) VALUES (?, ?, ?, 1)').run(p1, biz, gus);
  db.prepare('INSERT INTO partner_mailboxes (user_id, business_id, mailbox_id, can_send) VALUES (?, ?, ?, 0)').run(p2, biz, leo);
  const t = db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, ?, 'booking', 'new', 'Acme <a@acme.jp>', ?, ?)`);
  t.run(thrK, biz, leo, 'GTK', 'Leo の打ち合わせ', iso(Date.now())); t.run(thrH, biz, gus, 'GTH', 'Gus の打ち合わせ', iso(Date.now()));
  const s = db.prepare(`INSERT INTO suggestions (id, business_id, mailbox_id, thread_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, kind, counterpart_label, message_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'theirs', 'ai', ?, 'offer', 'Acme', ?, ?)`);
  s.run(newId(), biz, leo, thrK, 'GTK', 'mk', iso(T), iso(Date.now()), iso(Date.now()));
  s.run(newId(), biz, gus, thrH, 'GTH', 'mh', iso(T + DAY), iso(Date.now()), iso(Date.now()));
  const c = db.prepare(`INSERT INTO calendar_events (business_id, mailbox_id, google_calendar_id, google_event_id, start_utc, end_utc, title, location, meet_url, visibility, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`);
  c.run(biz, leo, 'leo@example.com', 'p1', iso(T + 2 * DAY), iso(T + 2 * DAY + 3600_000), 'Dentist SECRET', 'Clinic street 9', 'https://meet.google.com/sec-ret-xyz', 'private');
  c.run(biz, leo, 'leo@example.com', 'w1', iso(T + 3 * DAY), iso(T + 3 * DAY + 3600_000), 'Client call', null, null, 'default');
  c.run(biz, gus, 'gus@example.com', 'w2', iso(T + 4 * DAY), iso(T + 4 * DAY + 3600_000), 'Gus shoot', null, null, 'default');
  g = fakeGoogle();
});

async function as(email) {
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken(email) }), calendarClientFor: g.clientFor,
    gmailFactory: () => ({ getThread: async () => ({ messages: [] }) }) });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return (url, method = 'GET', payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}
const mode = (m) => db.prepare('UPDATE businesses SET calendar_mode = ? WHERE id = ?').run(m, biz);
const cal = (r, q = 'team') => r(`/api/calendar?from=${FROM}&to=${TO}&view=${encodeURIComponent(q)}`);

test('the card is absent when mode is not on for non-admins: shadow shows it to owners only, off to nobody', async () => {
  const owner = await as('leo@example.com'); const staff = await as('gus@example.com');
  assert.ok((await owner(`/api/threads/${thrK}`)).json().scheduling.offers.length === 1);
  assert.equal((await staff(`/api/me`)).json().calendar.visible, true);
  mode('shadow');
  assert.ok((await owner(`/api/threads/${thrK}`)).json().scheduling, 'owner (admin view) sees it in shadow');
  assert.equal((await staff(`/api/threads/${thrK}`)).json().scheduling, null);
  assert.equal((await staff(`/api/me`)).json().calendar.visible, false, 'no Rail entry for staff in shadow');
  assert.equal((await cal(staff)).statusCode, 404);
  mode('off');
  assert.equal((await owner(`/api/threads/${thrK}`)).json().scheduling, null);
  assert.equal((await owner(`/api/me`)).json().calendar.visible, false);
  assert.equal((await cal(owner)).statusCode, 404);
  assert.equal((await owner('/api/meetings/confirm', 'POST', { mailboxId: leo, start: iso(T) })).statusCode, 404);
  assert.equal(g.calls.length, 0);
});

test('a partner sees no card or calendar for a mailbox outside its scope', async () => {
  const p = await as('p@partner.jp');
  assert.equal((await p(`/api/threads/${thrK}`)).statusCode, 404);
  assert.ok((await p(`/api/threads/${thrH}`)).json().scheduling);
  assert.equal((await cal(p, `person:${leo}`)).statusCode, 403);
  const team = (await cal(p)).json();
  assert.deepEqual(team.people.map((x) => x.address), ['gus@example.com']);
  assert.ok(team.events.every((e) => e.mailboxId === gus), 'team view omits out-of-scope mailboxes');
  assert.ok(team.negotiations.every((n) => n.mailboxId === gus));
  assert.equal(team.view, 'team', 'no own mailbox: team by default (§8.3)');
});

test('a partner without send rights gets canSend false on the thread (no buttons) and 403 from confirm', async () => {
  const ro = await as('ro@partner.jp');
  const t = (await ro(`/api/threads/${thrK}`)).json();
  assert.equal(t.thread.canSend, false);
  assert.ok(t.scheduling);
  const sid = t.scheduling.offers[0].suggestionId;
  assert.equal((await ro('/api/meetings/confirm', 'POST', { suggestionId: sid })).statusCode, 403);
});

test('private fields are absent for everyone but the calendar owner; own view is the default (D39)', async () => {
  const owner = await as('leo@example.com'); const staff = await as('gus@example.com');
  const mine = (await owner(`/api/calendar?from=${FROM}&to=${TO}`)).json();
  assert.equal(mine.view, `person:${leo}`);
  assert.ok(mine.events.find((e) => e.title === 'Dentist SECRET'), 'own private event in full');
  assert.ok(!mine.people.some((x) => x.address === 'info@example.com'), 'the hold calendar owner is not a person');
  const theirs = await cal(staff, `person:${leo}`);
  assert.equal(theirs.statusCode, 200);
  const raw = theirs.body;
  for (const secret of ['Dentist', 'SECRET', 'Clinic', 'sec-ret']) assert.ok(!raw.includes(secret), `${secret} leaked`);
  const busy = theirs.json().events.find((e) => e.kind === 'busy');
  assert.deepEqual(Object.keys(busy).sort(), ['allDay', 'end', 'id', 'kind', 'mailboxId', 'start']);
  assert.ok(theirs.json().events.find((e) => e.title === 'Client call'));
  assert.ok(theirs.json().events.find((e) => e.kind === 'suggested' && e.threadId === thrK));
});

test('holds and confirmed meetings show from our rows; the negotiation lists its open dates', async () => {
  const owner = await as('leo@example.com');
  const t = (await owner(`/api/threads/${thrK}`)).json();
  const sid = t.scheduling.offers[0].suggestionId;
  assert.equal((await owner(`/api/suggestions/${sid}/hold`, 'POST')).statusCode, 200);
  let v = (await cal(owner, `person:${leo}`)).json();
  assert.ok(v.events.find((e) => e.kind === 'hold' && e.suggestionId === sid && e.title === '仮: Acme'));
  assert.equal(v.negotiations[0].state, 'held');
  const c = await owner('/api/meetings/confirm', 'POST', { suggestionId: sid });
  assert.equal(c.statusCode, 200, c.body);
  v = (await cal(owner, `person:${leo}`)).json();
  assert.ok(v.events.find((e) => e.kind === 'meeting' && e.meetingId === c.json().meeting.id && e.threadId === thrK));
  assert.ok(!v.events.some((e) => e.kind === 'hold'), 'the hold went away on confirm');
  assert.equal(v.negotiations.length, 0);
  const card = (await owner(`/api/threads/${thrK}`)).json().scheduling;
  assert.equal(card.meeting.id, c.json().meeting.id);
});

test('a drafting failure after the Google write is reported, not a failed confirm (the event stays, D37)', async () => {
  const v = newId();
  db.prepare("INSERT INTO voice_profiles (id, business_id, full_name, signature) VALUES (?, ?, '大野', '大野')").run(v, biz);
  db.prepare('UPDATE mailboxes SET voice_profile_id = ?').run(v);
  const inbound = { id: 'm1', threadId: 'GTK', labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'text/plain',
    headers: [{ name: 'From', value: 'Acme <a@acme.jp>' }, { name: 'Subject', value: 'x' }], body: { data: Buffer.from('ok').toString('base64url') } } };
  const app = buildApp({ db, config, ai: { complete: async () => ({ text: '', model: 'm' }) }, exchange: async () => ({ id_token: idToken('leo@example.com') }),
    calendarClientFor: g.clientFor, gmailFactory: () => ({ getThread: async () => ({ messages: [inbound] }) }) });
  const start = await app.inject('/auth/login');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${new URL(start.headers.location).searchParams.get('state')}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  const sid = db.prepare('SELECT id FROM suggestions WHERE mailbox_id = ?').get(leo).id;
  const r = await app.inject({ method: 'POST', url: '/api/meetings/confirm', headers: { cookie }, payload: { suggestionId: sid } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().draft, null);
  assert.match(r.json().draftError, /empty/);
  assert.equal(g.cal('leo@example.com').size, 1);
});
