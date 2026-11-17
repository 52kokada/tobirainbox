// Calendar plan step 11: holds lifecycle — auto holds for our offers, one click for theirs, fail closed
// without the D43 owner, 7-day silence expiry, hand edits flagged and never deleted.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { fakeGoogle } from './fake-calendar.js';
import { buildApp } from '../src/app.js';
import { holdPass, holdPassAll, holdSuggestion } from '../src/suggestions.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 0.5 };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const NOW = new Date('2026-11-08T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

let db; let biz; let leo; let gus; let info; let partnerId; let g;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); leo = newId(); gus = newId(); info = newId(); partnerId = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode, hold_calendar_id) VALUES (?, 'Tobira', 'active', 'delegated', 'on', 'hold@group')").run(biz);
  const m = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, ?, ?, 'connected', 'live')");
  m.run(leo, biz, 'leo@example.com', encrypt('r', masterKey)); m.run(gus, biz, 'gus@example.com', encrypt('r', masterKey)); m.run(info, biz, 'info@example.com', encrypt('r', masterKey));
  db.prepare('UPDATE businesses SET hold_calendar_owner_mailbox_id = ? WHERE id = ?').run(info, biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'leo@example.com', 'owner')").run(newId(), biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'p@partner.jp', 'partner')").run(partnerId, biz);
  db.prepare('INSERT INTO partner_mailboxes (user_id, business_id, mailbox_id, can_send) VALUES (?, ?, ?, 0)').run(partnerId, biz, gus);
  g = fakeGoogle();
});

function suggestion({ direction = 'ours', kind = 'offer', mailbox = leo, start = iso(NOW.getTime() + 3 * DAY), messageAt = iso(NOW.getTime() - DAY), thread = 'gt1' } = {}) {
  const id = newId();
  db.prepare(`INSERT INTO suggestions (id, business_id, mailbox_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, end_utc, kind, counterpart_label, message_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, 'Acme', ?, ?)`).run(id, biz, mailbox, thread, `m-${id}`, direction, start, iso(Date.parse(start) + 30 * 60_000), kind, messageAt, messageAt);
  return id;
}
const sug = (id) => db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
const holdsOf = (sid) => db.prepare('SELECT * FROM holds WHERE suggestion_id = ?').all(sid);
const pass = (now = NOW) => holdPass({ db, businessId: biz, clientFor: g.clientFor, now });

async function as(email) {
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken(email) }), calendarClientFor: g.clientFor });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

test('our offer is held automatically on the 調整中 calendar as its owner: "仮: <client>", no attendees, sendUpdates none', async () => {
  const ours = suggestion();
  const theirs = suggestion({ direction: 'theirs', thread: 'gt2' });
  const r = await pass();
  assert.equal(r.placed, 1);
  assert.equal(sug(ours).state, 'held');
  assert.equal(sug(theirs).state, 'suggested');
  assert.equal(holdsOf(theirs).length, 0);
  const [h] = holdsOf(ours);
  assert.deepEqual([h.state, h.google_calendar_id], ['active', 'hold@group']);
  const ins = g.writes();
  assert.equal(ins.length, 1);
  assert.equal(ins[0].calId, 'hold@group');
  assert.equal(ins[0].body.summary, '仮: Acme');
  assert.equal(ins[0].body.attendees, undefined);
  assert.equal(ins[0].q.sendUpdates, 'none');
  assert.deepEqual(ins[0].body.extendedProperties.private, { tobiraInbox: '1', tbiKind: 'hold', tbiId: h.id, tbiBusiness: biz });
  assert.ok(g.asked.every((a) => a === 'info@example.com'), 'holds are written only as the D43 owner');
  // A second pass places nothing new.
  assert.equal((await pass()).placed, 0);
  assert.equal(g.writes().length, 1);
});

test("theirs waits for POST /api/suggestions/:id/hold; dismiss releases the hold", async () => {
  const theirs = suggestion({ direction: 'theirs', start: iso(Date.now() + 3 * DAY) });
  await pass(new Date());
  assert.equal(holdsOf(theirs).length, 0);
  const owner = await as('leo@example.com');
  const r = await owner('POST', `/api/suggestions/${theirs}/hold`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(sug(theirs).state, 'held');
  assert.equal(g.cal('hold@group').size, 1);
  const d = await owner('POST', `/api/suggestions/${theirs}/dismiss`);
  assert.equal(d.statusCode, 200);
  assert.equal(sug(theirs).state, 'dismissed');
  assert.equal(holdsOf(theirs)[0].state, 'removed');
  assert.equal(g.cal('hold@group').size, 0);
});

test('a partner without canSee gets 403 on hold and dismiss; with canSee it works', async () => {
  const outside = suggestion({ direction: 'theirs', mailbox: leo, start: iso(Date.now() + 3 * DAY) });
  const inside = suggestion({ direction: 'theirs', mailbox: gus, thread: 'gt9', start: iso(Date.now() + 3 * DAY) });
  const partner = await as('p@partner.jp');
  assert.equal((await partner('POST', `/api/suggestions/${outside}/hold`)).statusCode, 403);
  assert.equal((await partner('POST', `/api/suggestions/${outside}/dismiss`)).statusCode, 403);
  assert.equal(sug(outside).state, 'suggested');
  assert.equal(g.writes().length, 0);
  assert.equal((await partner('POST', `/api/suggestions/${inside}/hold`)).statusCode, 200);
  assert.equal((await partner('POST', '/api/suggestions/nope/hold')).statusCode, 404);
});

test("calendar_mode 'off': routes 404 and the hold pass does nothing", async () => {
  db.prepare("UPDATE businesses SET calendar_mode = 'off'").run();
  const ours = suggestion();
  assert.deepEqual(await holdPassAll({ db, clientFor: g.clientFor, now: NOW }), []);
  const owner = await as('leo@example.com');
  assert.equal((await owner('POST', `/api/suggestions/${ours}/hold`)).statusCode, 404);
  assert.equal(g.calls.length, 0);
  assert.equal(sug(ours).state, 'suggested');
});

test('a NULL owner places nothing anywhere and records the error; the suggestion stays suggested', async () => {
  db.prepare('UPDATE businesses SET hold_calendar_owner_mailbox_id = NULL').run();
  const ours = suggestion();
  const r = await pass();
  assert.equal(r.placed, 0);
  assert.equal(r.errors, 1);
  assert.equal(g.calls.length, 0);
  assert.equal(sug(ours).state, 'suggested');
  assert.equal(holdsOf(ours).length, 0);
  const w = db.prepare("SELECT * FROM calendar_writes WHERE kind = 'hold_place'").get();
  assert.equal(w.status, 'failed');
  assert.match(w.last_error, /no_owner/);
  // A disconnected owner also fails closed (never falls back to the thread's own mailbox).
  db.prepare("UPDATE businesses SET hold_calendar_owner_mailbox_id = ?").run(info);
  db.prepare("UPDATE mailboxes SET status = 'error' WHERE id = ?").run(info);
  await assert.rejects(holdSuggestion({ db, businessId: biz, suggestionId: ours, clientFor: g.clientFor, now: NOW }), (e) => e.code === 'owner_unavailable');
  assert.equal(g.calls.length, 0);
});

test('a hold expires after 7 days of silence on its thread, or when its time has passed; only then is it deleted', async () => {
  const ours = suggestion({ start: iso(NOW.getTime() + 20 * DAY), messageAt: iso(NOW.getTime() - DAY) });
  await pass();
  const [h] = holdsOf(ours);
  // Day 6 of silence: still active.
  assert.equal((await pass(new Date(NOW.getTime() + 5 * DAY))).expired, 0);
  assert.equal(holdsOf(ours)[0].state, 'active');
  // New mail on the thread at day 5 moves the silence window.
  db.prepare("INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, status, last_message_at) VALUES (?, ?, ?, 'gt1', 'x', 'new', ?)").run(newId(), biz, leo, iso(NOW.getTime() + 5 * DAY));
  assert.equal((await pass(new Date(NOW.getTime() + 8 * DAY))).expired, 0);
  // 7 days after that mail: expired and deleted from Google.
  const r = await pass(new Date(NOW.getTime() + 12 * DAY + 1000));
  assert.equal(r.expired, 1);
  assert.equal(holdsOf(ours)[0].state, 'expired');
  assert.equal(g.cal('hold@group').has(h.google_event_id), false);

  const soon = suggestion({ start: iso(NOW.getTime() + 2 * 3600_000), messageAt: iso(NOW.getTime()), thread: 'gt3' });
  await pass();
  assert.equal(holdsOf(soon)[0].state, 'active');
  assert.equal((await pass(new Date(NOW.getTime() + 3 * 3600_000))).expired, 1);
  assert.equal(holdsOf(soon)[0].state, 'expired');
});

test('a hold edited by hand in Google is flagged, not deleted (seen by the read sync, or by the delete check)', async () => {
  const a = suggestion({ start: iso(NOW.getTime() + 2 * DAY) });
  const b = suggestion({ start: iso(NOW.getTime() + 2 * DAY + 3600_000), thread: 'gt2' });
  await pass();
  const [ha] = holdsOf(a); const [hb] = holdsOf(b);
  // a: the read sync cached the hand-edited etag.
  const edited = g.handEdit('hold@group', ha.google_event_id);
  db.prepare(`INSERT INTO calendar_events (business_id, mailbox_id, google_calendar_id, google_event_id, etag, start_utc, end_utc, ours_tag)
    VALUES (?, NULL, 'hold@group', ?, ?, ?, ?, ?)`).run(biz, ha.google_event_id, edited.etag, ha.expires_at, ha.expires_at, `hold:${ha.id}`);
  // b: edited, not yet synced; found when expiry tries to delete it.
  g.handEdit('hold@group', hb.google_event_id);
  const r = await pass(new Date(NOW.getTime() + 3 * DAY));
  assert.equal(r.flagged, 2);
  assert.deepEqual(holdsOf(a).map((h) => [h.state, h.flagged_reason]), [['flagged', 'edited in Google']]);
  assert.equal(holdsOf(b)[0].state, 'flagged');
  assert.equal(g.calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(g.cal('hold@group').size, 2);
});

test('in shadow mode holds land only on the shadow calendar', async () => {
  db.prepare("UPDATE businesses SET calendar_mode = 'shadow', shadow_calendar_id = 'shadow@group'").run();
  suggestion();
  await pass();
  assert.deepEqual(g.writes().map((c) => c.calId), ['shadow@group']);
  db.prepare('UPDATE businesses SET shadow_calendar_id = NULL').run();
  const r = await (async () => { suggestion({ thread: 'gt5' }); return pass(); })();
  assert.equal(r.placed, 0);
  assert.deepEqual(g.writes().map((c) => c.calId), ['shadow@group']);
});
