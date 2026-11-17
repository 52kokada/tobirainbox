// Calendar plan step 15 (D41, D50): the Google invite goes out only when the confirmation email is really
// delivered after its undo window; undoing the email inside the window cancels it with no Google call.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { deliverDue } from '../src/send-queue.js';
import { sendDueInvites } from '../src/meetings.js';
import { fakeGoogle } from './fake-calendar.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 5 };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const DAY = 86_400_000;
const START = new Date(Date.now() + 3 * DAY); START.setUTCHours(1, 0, 0, 0);
const mail = [{
  id: 'm1', threadId: 'GT1', labelIds: ['INBOX'], internalDate: String(Date.now() - 3600_000),
  payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'Acme <a@acme.jp>' }, { name: 'Subject', value: 'お打ち合わせ' }, { name: 'Message-ID', value: '<x@acme.jp>' },
  ], body: { data: b64('Zoom https://us02web.zoom.us/j/123456789 でお願いします') } },
}];
const ai = { complete: async (req) => ({ text: 'Acme様\n\n確定しました。\n\n大野', model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0 }) };

let db; let biz; let leo; let thr; let g; let req; let delivered;
const later = () => new Date(Date.now() + 60_000);
const transport = { send: async () => { delivered += 1; return { messageId: `gm-${delivered}` }; } };
const pass = () => sendDueInvites({ db, clientFor: g.clientFor, log: {} });
const meeting = () => db.prepare('SELECT * FROM meetings').get();
const invitePatches = () => g.writes().filter((c) => c.method === 'PATCH' && c.body.attendees);

beforeEach(async () => {
  db = openDb(':memory:'); delivered = 0;
  biz = newId(); leo = newId(); thr = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode, hold_calendar_id) VALUES (?, 'Tobira', 'active', 'delegated', 'on', 'hold@group')").run(biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'live', 0)").run(leo, biz, encrypt('r', masterKey));
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'leo@example.com', 'owner')").run(newId(), biz);
  const v = newId();
  db.prepare("INSERT INTO voice_profiles (id, business_id, full_name, signature) VALUES (?, ?, '大野', '大野')").run(v, biz);
  db.prepare('UPDATE mailboxes SET voice_profile_id = ? WHERE id = ?').run(v, leo);
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, 'GT1', 'booking', 'new', 'Acme <a@acme.jp>', 'お打ち合わせ', ?)`).run(thr, biz, leo, new Date().toISOString());
  g = fakeGoogle();
  const app = buildApp({ db, config, ai, exchange: async () => ({ id_token: idToken('leo@example.com') }), calendarClientFor: g.clientFor,
    gmailFactory: () => ({ getThread: async () => ({ messages: mail }) }) });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  req = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
});

async function confirmAndTick() {
  const c = await req('POST', '/api/meetings/confirm', { mailboxId: leo, threadId: thr, start: START.toISOString() });
  assert.equal(c.statusCode, 200, c.body);
  const t = await req('POST', `/api/meetings/${c.json().meeting.id}/invite`, { want: true });
  assert.equal(t.statusCode, 200, t.body);
  assert.equal(t.json().meeting.invite, 'queued');
  return c.json();
}

test('no Google call until delivery; after the undo window the invite goes once, to the counterpart, with sendUpdates all', async () => {
  const c = await confirmAndTick();
  const writesAfterConfirm = g.writes().length;
  const s = await req('POST', `/api/threads/${thr}/send`, { draftId: c.draft.id });
  assert.equal(s.statusCode, 200, s.body);
  await pass();
  await deliverDue(db, transport, { now: new Date() }); // still inside the undo window
  await pass();
  assert.equal(g.writes().length, writesAfterConfirm, 'nothing reaches Google before delivery');
  await deliverDue(db, transport, { now: later() });
  assert.equal(delivered, 1);
  await pass();
  const [p, ...more] = invitePatches();
  assert.equal(more.length, 0);
  assert.equal(p.q.sendUpdates, 'all');
  assert.deepEqual(p.body.attendees, [{ email: 'a@acme.jp' }]);
  assert.equal(meeting().invite_state, 'sent');
  await deliverDue(db, transport, { now: later() });
  await pass(); await pass();
  assert.equal(invitePatches().length, 1, 'one invite, however often the passes run');
});

test("the email's undo inside the window cancels the invite with no Google call", async () => {
  const c = await confirmAndTick();
  const n = g.calls.length;
  const s = (await req('POST', `/api/threads/${thr}/send`, { draftId: c.draft.id })).json();
  assert.equal((await req('POST', `/api/sends/${s.sendId}/undo`)).statusCode, 200);
  assert.equal(meeting().invite_state, 'none');
  await deliverDue(db, transport, { now: later() });
  await pass();
  assert.equal(g.calls.length, n);
  assert.equal(delivered, 0);
});

test('a delivery failure sends no invite', async () => {
  const c = await confirmAndTick();
  await req('POST', `/api/threads/${thr}/send`, { draftId: c.draft.id });
  const broken = { send: async () => { throw new Error('gmail 500'); } };
  for (let i = 0; i < 3; i += 1) await deliverDue(db, broken, { now: later() });
  assert.equal(db.prepare('SELECT status FROM sends').get().status, 'failed');
  await pass();
  assert.equal(invitePatches().length, 0);
  assert.equal(meeting().invite_state, 'queued');
});

test('an edited confirmation (a new version at Send) still carries the invite', async () => {
  const c = await confirmAndTick();
  await req('POST', `/api/threads/${thr}/send`, { draftId: c.draft.id, body: `${c.draft.body}\n\n追伸: よろしくお願いします。` });
  const sentDraft = db.prepare("SELECT * FROM drafts WHERE status = 'queued'").get();
  assert.notEqual(sentDraft.id, c.draft.id);
  assert.equal(sentDraft.meeting_id, c.meeting.id);
  await deliverDue(db, transport, { now: later() });
  await pass();
  assert.equal(invitePatches().length, 1);
});

test('calendar_mode off: the pass sends nothing', async () => {
  const c = await confirmAndTick();
  await req('POST', `/api/threads/${thr}/send`, { draftId: c.draft.id });
  await deliverDue(db, transport, { now: later() });
  db.prepare("UPDATE businesses SET calendar_mode = 'off' WHERE id = ?").run(biz);
  assert.deepEqual(await pass(), []);
  assert.equal(invitePatches().length, 0);
});
