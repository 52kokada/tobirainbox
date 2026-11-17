// Calendar plan step 12: free-slot drafting (D4, D9, D49). One freeBusy read of the owner, ticked attendees
// and always the 調整中 calendar; attendees go nowhere else; hours from free_slot_hours in the business zone.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { fakeGoogle } from './fake-calendar.js';
import { openSlots, pickSlots, slotLabel, slotsInstruction } from '../src/free-slots.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 5 };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const inbound = {
  id: 'm1', threadId: 'GT1', labelIds: ['INBOX'], internalDate: String(Date.now() - 3600_000),
  payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'Acme <a@acme.jp>' }, { name: 'Subject', value: 'お打ち合わせ' }, { name: 'Message-ID', value: '<x@acme.jp>' },
  ], body: { data: b64('来週お打ち合わせできますか') } },
};

let db; let biz; let leo; let gus; let ada; let thr; let partnerId; let g; let prompts;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); leo = newId(); gus = newId(); ada = newId(); thr = newId(); partnerId = newId(); prompts = [];
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode, hold_calendar_id) VALUES (?, 'Tobira', 'active', 'delegated', 'on', 'hold@group')").run(biz);
  const m = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, ?, ?, 'connected', 'live', 0)");
  for (const [id, a] of [[leo, 'leo'], [gus, 'gus'], [ada, 'ada']]) m.run(id, biz, `${a}@example.com`, encrypt('r', masterKey));
  db.prepare('UPDATE businesses SET hold_calendar_owner_mailbox_id = ? WHERE id = ?').run(ada, biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'leo@example.com', 'owner')").run(newId(), biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'p@partner.jp', 'partner')").run(partnerId, biz);
  db.prepare('INSERT INTO partner_mailboxes (user_id, business_id, mailbox_id, can_send) VALUES (?, ?, ?, 1)').run(partnerId, biz, leo);
  const v = newId();
  db.prepare("INSERT INTO voice_profiles (id, business_id, full_name, signature) VALUES (?, ?, '大野', '大野')").run(v, biz);
  db.prepare('UPDATE mailboxes SET voice_profile_id = ? WHERE business_id = ?').run(v, biz);
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, 'GT1', 'booking', 'new', 'Acme <a@acme.jp>', 'お打ち合わせ', ?)`).run(thr, biz, leo, new Date().toISOString());
  g = fakeGoogle();
});

const ai = { complete: async (req) => { prompts.push(req); return { text: 'Acme様\n\n候補をお送りします。\n\n大野', model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0 }; } };
async function as(email, google = g) {
  const app = buildApp({ db, config, ai, exchange: async () => ({ id_token: idToken(email) }), calendarClientFor: google.clientFor,
    gmailFactory: () => ({ getThread: async () => ({ messages: [inbound] }) }) });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}
const fb = (google = g) => google.calls.filter((c) => c.freeBusy);

test('the 調整中 calendar is always in the freeBusy request; ticked attendees are in it and nowhere else', async () => {
  const owner = await as('leo@example.com');
  const r = await owner('POST', `/api/threads/${thr}/draft-slots`, { attendeeMailboxIds: [gus] });
  assert.equal(r.statusCode, 200, r.body);
  const [call, ...more] = fb();
  assert.equal(more.length, 0, 'one freeBusy call');
  assert.deepEqual(call.body.items.map((i) => i.id), ['leo@example.com', 'gus@example.com', 'hold@group']);
  assert.equal(r.json().slots.length, 3);
  assert.equal(g.writes().length, 0, 'no Google write');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM holds').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meetings').get().n, 0);
  assert.ok(!JSON.stringify(prompts).includes('gus'), 'attendee not in the draft prompt');
  assert.match(prompts.at(-1).variable ?? prompts.at(-1).prompt ?? JSON.stringify(prompts.at(-1)), /日程の候補/);
  assert.match(r.json().draft.body, /候補/);
  // Without ticks the hold calendar is still read.
  await owner('POST', `/api/threads/${thr}/draft-slots`, {});
  assert.deepEqual(fb().at(-1).body.items.map((i) => i.id), ['leo@example.com', 'hold@group']);
});

test('busy time on any calendar, including holds for someone else, is never offered', () => {
  const now = new Date('2026-11-09T00:00:00Z'); // Mon 09:00 JST
  const busy = [{ start: '2026-11-09T01:00:00Z', end: '2026-11-09T09:00:00Z' }]; // Mon 10:00-18:00 JST
  const slots = openSlots({ busy, from: now.toISOString(), to: '2026-11-11T15:00:00Z', businessTz: 'Asia/Tokyo', now });
  assert.ok(slots.every((s) => !s.start.startsWith('2026-11-09')), 'Monday is fully busy');
  assert.equal(slots[0].start, '2026-11-10T01:00:00.000Z'); // Tue 10:00 JST
  const picked = pickSlots(slots, 3, 'Asia/Tokyo');
  assert.deepEqual(picked.map((s) => slotLabel(s)), ['11月10日(火) 10:00〜10:30', '11月11日(水) 10:00〜10:30', '11月10日(火) 10:30〜11:00'].sort());
  assert.match(slotsInstruction(picked), /日本時間/);
});

test('free_slot_hours (D49) and the business timezone are respected across a DST change', () => {
  const tz = 'America/Los_Angeles';
  const hours = { days: [1], from: '09:00', to: '10:00' }; // Mondays 09:00-10:00 local
  const now = new Date('2026-10-25T00:00:00Z');
  const slots = openSlots({ from: now.toISOString(), to: '2026-11-10T00:00:00Z', businessTz: tz, hours, now });
  // 10-26 is PDT (UTC-7), 11-02 and 11-09 are PST (UTC-8).
  assert.deepEqual(slots.map((s) => s.start), [
    '2026-10-26T16:00:00.000Z', '2026-10-26T16:30:00.000Z',
    '2026-11-02T17:00:00.000Z', '2026-11-02T17:30:00.000Z',
    '2026-11-09T17:00:00.000Z', '2026-11-09T17:30:00.000Z',
  ]);
});

test('the stored free_slot_hours setting drives the route', async () => {
  db.prepare(`UPDATE businesses SET free_slot_hours = '{"days":[0,1,2,3,4,5,6],"from":"13:00","to":"14:00"}' WHERE id = ?`).run(biz);
  const owner = await as('leo@example.com');
  const r = await owner('POST', `/api/threads/${thr}/draft-slots`, {});
  assert.equal(r.statusCode, 200, r.body);
  for (const s of r.json().slots) assert.match(slotLabel(s), /13:(00|30)〜/);
});

test('a partner can tick only mailboxes it can see', async () => {
  const p = await as('p@partner.jp');
  const bad = await p('POST', `/api/threads/${thr}/draft-slots`, { attendeeMailboxIds: [gus] });
  assert.equal(bad.statusCode, 403);
  assert.equal(fb().length, 0, 'nothing read when a tick is out of scope');
  const ok = await p('POST', `/api/threads/${thr}/draft-slots`, { attendeeMailboxIds: [leo] });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('a calendar Google cannot read fails the request: no draft offers unchecked times', async () => {
  const g2 = fakeGoogle({ unreadable: ['hold@group'] });
  const owner = await as('leo@example.com', g2);
  const r = await owner('POST', `/api/threads/${thr}/draft-slots`, {});
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'calendar_unreadable');
  assert.equal(prompts.length, 0);
});

test('route is 404 when calendar_mode is off, with no Google call', async () => {
  db.prepare("UPDATE businesses SET calendar_mode = 'off' WHERE id = ?").run(biz);
  const owner = await as('leo@example.com');
  const r = await owner('POST', `/api/threads/${thr}/draft-slots`, {});
  assert.equal(r.statusCode, 404);
  assert.equal(g.calls.length, 0);
});
