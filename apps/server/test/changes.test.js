// Calendar plan step 14 (D13): a change or cancel found in mail on a thread with a confirmed meeting is a
// "変更の提案"; one click applies it. Patch with the stored etag; delete only our tagged event; attendees are
// told (sendUpdates 'all') only when an invite was sent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { fakeGoogle } from './fake-calendar.js';
import { confirmMeeting } from '../src/calendar-writes.js';
import { recordSuggestions } from '../src/suggestions.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 5 };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const DAY = 86_400_000;
const T0 = Date.now() + 3 * DAY;
const iso = (ms) => new Date(ms).toISOString();

let db; let biz; let leo; let thr; let partnerId; let g; let meetingId;
beforeEach(async () => {
  db = openDb(':memory:');
  biz = newId(); leo = newId(); thr = newId(); partnerId = newId(); meetingId = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode, hold_calendar_id) VALUES (?, 'Tobira', 'active', 'delegated', 'on', 'hold@group')").run(biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'live')").run(leo, biz, encrypt('r', masterKey));
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'leo@example.com', 'owner')").run(newId(), biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'p@partner.jp', 'partner')").run(partnerId, biz);
  db.prepare('INSERT INTO partner_mailboxes (user_id, business_id, mailbox_id, can_send) VALUES (?, ?, ?, 0)').run(partnerId, biz, leo);
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, 'GT1', 'booking', 'new', 'Acme <a@acme.jp>', 'お打ち合わせ', ?)`).run(thr, biz, leo, iso(Date.now()));
  db.prepare(`INSERT INTO meetings (id, business_id, thread_id, mailbox_id, start_utc, end_utc, title, confirmed_via, idem_key)
    VALUES (?, ?, ?, ?, ?, ?, 'Acme 打ち合わせ', 'console', ?)`).run(meetingId, biz, thr, leo, iso(T0), iso(T0 + 3600_000), `confirm:${meetingId}`);
  g = fakeGoogle();
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  await confirmMeeting({ db, businessId: biz, meeting: m, mailbox: db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(leo), clientFor: g.clientFor });
});

const mailbox = () => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(leo);
const meeting = () => db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
function detect(kind, startMs, id = `msg-${kind}`) {
  return recordSuggestions(db, {
    mailbox: mailbox(), msg: { id, threadId: 'GT1' }, source: 'ai', businessTz: 'Asia/Tokyo',
    prep: { direction: 'theirs', sentAt: iso(Date.now()), counterpart: 'Acme' },
    dates: [{ startUtc: iso(startMs), endUtc: null, tz: 'Asia/Tokyo', tzSource: 'business', kind, quote: '日程変更' }],
  })[0];
}
async function as(email) {
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken(email) }), calendarClientFor: g.clientFor });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

test('a change on the thread sets the pending change; an offer on it does not; nothing moves in Google', () => {
  detect('offer', T0 + DAY, 'msg-offer');
  assert.equal(meeting().pending_change_suggestion_id, null);
  const s = detect('change', T0 + DAY);
  assert.equal(meeting().pending_change_suggestion_id, s.id);
  assert.equal(g.writes().filter((c) => c.method !== 'POST').length, 0);
});

test('apply-change moves the event via patch with the stored etag, keeps the length, sendUpdates none without an invite', async () => {
  const s = detect('change', T0 + DAY);
  const etag = meeting().etag;
  const owner = await as('leo@example.com');
  const r = await owner('POST', `/api/meetings/${meetingId}/apply-change`);
  assert.equal(r.statusCode, 200, r.body);
  const patch = g.writes().find((c) => c.method === 'PATCH');
  assert.equal(patch.ifMatch, etag);
  assert.equal(patch.q.sendUpdates, 'none');
  assert.equal(patch.body.start.dateTime, iso(T0 + DAY));
  assert.equal(patch.body.end.dateTime, iso(T0 + DAY + 3600_000));
  const m = meeting();
  assert.deepEqual([m.start_utc, m.pending_change_suggestion_id, m.state], [iso(T0 + DAY), null, 'confirmed']);
  assert.notEqual(m.etag, etag, 'our new etag is stored, so cleanup never flags our own patch');
  assert.equal(db.prepare('SELECT state FROM suggestions WHERE id = ?').get(s.id).state, 'superseded');
  assert.equal((await owner('POST', `/api/meetings/${meetingId}/apply-change`)).statusCode, 409, 'nothing waiting any more');
});

test('a cancel deletes our tagged event; sendUpdates is all only when the invite was sent', async () => {
  db.prepare("UPDATE meetings SET invite_state = 'sent' WHERE id = ?").run(meetingId);
  detect('cancel', T0);
  const owner = await as('leo@example.com');
  const r = await owner('POST', `/api/meetings/${meetingId}/apply-change`);
  assert.equal(r.statusCode, 200, r.body);
  const del = g.writes().find((c) => c.method === 'DELETE');
  assert.equal(del.q.sendUpdates, 'all');
  assert.equal(g.cal('leo@example.com').size, 0);
  assert.equal(meeting().state, 'cancelled');
});

test('a hand-edited event is refused, not overwritten', async () => {
  detect('change', T0 + DAY);
  g.handEdit('leo@example.com', meeting().google_event_id);
  const owner = await as('leo@example.com');
  const r = await owner('POST', `/api/meetings/${meetingId}/apply-change`);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'hand_edited');
  assert.equal(meeting().start_utc, iso(T0));
});

test('dismissing the change clears the badge; partners without send rights cannot apply', async () => {
  const s = detect('change', T0 + DAY);
  const p = await as('p@partner.jp');
  assert.equal((await p('POST', `/api/meetings/${meetingId}/apply-change`)).statusCode, 403);
  const owner = await as('leo@example.com');
  assert.equal((await owner('POST', `/api/suggestions/${s.id}/dismiss`)).statusCode, 200);
  assert.equal(meeting().pending_change_suggestion_id, null);
});
