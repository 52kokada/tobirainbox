// 予約送信 (scheduled send): waits for its time, can be cancelled, moved or sent now, leaves 要対応 for 予約,
// and is held (never sent stale) when a newer message reaches the thread first.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId, Store } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { deliverDue, queueSend, rescheduleSend, SendRefused } from '../src/send-queue.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 0.5 };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const MIN = 60_000; const HOUR = 60 * MIN;

let db; let biz; let user; let mbx; let thr; let draftId; let delivered;
const transport = { send: async ({ send }) => { delivered.push(send.id); return { messageId: `gm-${send.id}` }; } };

beforeEach(() => {
  db = openDb(':memory:'); delivered = [];
  biz = newId(); user = newId(); mbx = newId(); thr = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Shop', 'active')").run(biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'owner@shop.jp', 'owner')").run(user, biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'info@shop.jp', ?, 'connected', 'live', 0)")
    .run(mbx, biz, encrypt('r', masterKey));
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, 'GT1', 'M1', 'inquiry', 'drafted', '客 <c@x.jp>', 'ご予約の件', '2026-11-05T00:00:00Z')`).run(thr, biz, mbx);
  draftId = new Store(db, biz).saveDraft({ threadId: thr, bodyText: '佐藤様\n\n承知いたしました。', createdBy: 'ai' });
});

async function as(email) {
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken(email) }), gmailFactory: () => ({ getThread: async () => ({ messages: [] }) }) });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}
const ids = async (call, view) => (await call('GET', `/api/threads?view=${view}`)).json().threads.map((t) => t.id);

test('a scheduled reply waits for its time, moves from 要対応 to 予約, then sends', async () => {
  const call = await as('owner@shop.jp');
  assert.deepEqual(await ids(call, 'todo'), [thr]);
  const at = new Date(Date.now() + 2 * HOUR).toISOString();
  const r = await call('POST', `/api/threads/${thr}/send`, { draftId, sendAt: at });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().scheduledAt, at);
  assert.deepEqual(await ids(call, 'todo'), [], 'no longer waiting for a reply');
  const list = (await call('GET', '/api/threads?view=scheduled')).json();
  assert.deepEqual(list.threads.map((t) => [t.id, t.scheduledAt]), [[thr, at]]);
  assert.equal(list.counts.scheduled, 1);
  const view = (await call('GET', `/api/threads/${thr}`)).json();
  assert.equal(view.pendingSend.scheduledAt, at);
  assert.match(view.pendingSend.body, /承知いたしました/);

  await deliverDue(db, transport, { now: new Date(Date.now() + HOUR) });
  assert.deepEqual(delivered, [], 'not before its time');
  await deliverDue(db, transport, { now: new Date(Date.now() + 2 * HOUR + 1000) });
  assert.equal(delivered.length, 1);
  assert.equal(db.prepare('SELECT status FROM threads WHERE id = ?').get(thr).status, 'sent');
  assert.deepEqual(await ids(call, 'scheduled'), []);
});

test('times too soon, too far or unreadable are refused, and nothing is queued', async () => {
  const s = new Store(db, biz);
  for (const [sendAt, code] of [[new Date(Date.now() + 10_000).toISOString(), 'too_soon'], [new Date(Date.now() + 61 * 86400_000).toISOString(), 'too_far'], ['tomorrow-ish', 'bad_time']]) {
    assert.throws(() => queueSend(s, { userId: user, draftId, sendAt }), (e) => e instanceof SendRefused && e.code === code, code);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sends').get().n, 0);
  assert.equal(s.draft(draftId).status, 'open');
});

test('cancel puts it back in 要対応 with the draft editable; it can then be sent normally', async () => {
  const call = await as('owner@shop.jp');
  const { sendId } = (await call('POST', `/api/threads/${thr}/send`, { draftId, sendAt: new Date(Date.now() + 3 * HOUR).toISOString() })).json();
  assert.equal((await call('POST', `/api/sends/${sendId}/undo`, {})).statusCode, 200);
  assert.deepEqual(await ids(call, 'todo'), [thr]);
  assert.equal(new Store(db, biz).draft(draftId).status, 'open');
  assert.equal((await call('POST', `/api/threads/${thr}/send`, { draftId })).statusCode, 200, 'the same draft can be queued again');
});

test('move to another time, or send now (ordinary undo window); not once it has gone', async () => {
  const s = new Store(db, biz);
  const now = new Date();
  const { sendId } = queueSend(s, { userId: user, draftId, sendAt: new Date(now.getTime() + 5 * HOUR).toISOString(), now });
  const later = new Date(now.getTime() + 26 * HOUR).toISOString();
  assert.equal(rescheduleSend(s, { userId: user, sendId, sendAt: later, now }).scheduledAt, later);
  assert.throws(() => rescheduleSend(s, { userId: user, sendId, sendAt: new Date(now.getTime() + 5000).toISOString(), now }), (e) => e.code === 'too_soon');
  const r = rescheduleSend(s, { userId: user, sendId, sendNow: true, now });
  assert.equal(r.scheduledAt, null);
  assert.ok(new Date(r.undoUntil) - now <= 30_000, 'send now keeps the short undo window');
  await deliverDue(db, transport, { now: new Date(now.getTime() + 31_000) });
  assert.deepEqual(delivered, [sendId]);
  assert.throws(() => rescheduleSend(s, { userId: user, sendId, sendAt: later, now }), (e) => e.code === 'too_late');
});

test('a newer message in the thread holds the scheduled reply right away: not sent, back in 要対応, owner alerted', async () => {
  const call = await as('owner@shop.jp');
  const { sendId } = (await call('POST', `/api/threads/${thr}/send`, { draftId, sendAt: new Date(Date.now() + 24 * HOUR).toISOString() })).json();
  await deliverDue(db, transport);
  assert.equal(db.prepare('SELECT status FROM sends WHERE id = ?').get(sendId).status, 'queued', 'nothing new yet: still waiting');
  // The customer writes again before the scheduled time.
  db.prepare("UPDATE threads SET last_message_id = 'M2', status = 'new' WHERE id = ?").run(thr);
  const r = await deliverDue(db, transport);
  assert.deepEqual(r, [{ id: sendId, status: 'held' }]);
  assert.deepEqual(delivered, []);
  assert.equal(new Store(db, biz).draft(draftId).status, 'open');
  assert.deepEqual(await ids(call, 'todo'), [thr]);
  const alerts = (await call('GET', '/api/alerts')).json().alerts;
  assert.ok(alerts.some((a) => a.title.startsWith('予約送信を止めました')), JSON.stringify(alerts));
  await deliverDue(db, transport, { now: new Date(Date.now() + 25 * HOUR) });
  assert.deepEqual(delivered, [], 'held for good');
});

test('an ordinary send is never held by a newer message (its 30 s window is the person\'s own call)', async () => {
  const s = new Store(db, biz);
  const { sendId } = queueSend(s, { userId: user, draftId });
  db.prepare("UPDATE threads SET last_message_id = 'M2' WHERE id = ?").run(thr);
  await deliverDue(db, transport, { now: new Date(Date.now() + 31_000) });
  assert.deepEqual(delivered, [sendId]);
});

test('a partner without send rights can neither schedule nor move a send', async () => {
  const pid = newId();
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'p@partner.jp', 'partner')").run(pid, biz);
  db.prepare('INSERT INTO partner_mailboxes (user_id, mailbox_id, business_id, can_send) VALUES (?, ?, ?, 0)').run(pid, mbx, biz);
  const call = await as('p@partner.jp');
  const r = await call('POST', `/api/threads/${thr}/send`, { draftId, sendAt: new Date(Date.now() + HOUR).toISOString() });
  assert.equal(r.statusCode, 403);
  const { sendId } = queueSend(new Store(db, biz), { userId: user, draftId, sendAt: new Date(Date.now() + HOUR).toISOString() });
  assert.equal((await call('POST', `/api/sends/${sendId}/schedule`, { now: true })).statusCode, 409);
});

test('CC copies: scheduling from one box takes both out of 要対応; the copy closing never closes the scheduled one; cancel brings the reply back', async () => {
  const mbx2 = newId(); const copy = newId();
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'boss@shop.jp', ?, 'connected', 'live', 0)")
    .run(mbx2, biz, encrypt('r', masterKey));
  db.prepare("UPDATE threads SET last_rfc_message_id = '<cc@x.jp>' WHERE id = ?").run(thr);
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, last_rfc_message_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, 'GT2', 'M1b', '<cc@x.jp>', 'inquiry', 'new', '客 <c@x.jp>', 'ご予約の件', '2026-11-05T00:00:00Z')`).run(copy, biz, mbx2);
  const call = await as('owner@shop.jp');
  const { sendId } = (await call('POST', `/api/threads/${thr}/send`, { draftId, sendAt: new Date(Date.now() + 5 * HOUR).toISOString() })).json();
  assert.deepEqual(await ids(call, 'todo'), [], 'neither copy waits in 要対応');
  assert.equal((await call('GET', '/api/threads?view=scheduled')).json().threads.length, 1, 'one row for the email');
  // The copy gets closed (e.g. a teammate owns it): the scheduled one stays open with its reply queued.
  const { closeCopies } = await import('../src/copies.js');
  db.prepare("UPDATE threads SET status = 'done' WHERE id = ?").run(copy); closeCopies(db, copy, 'done');
  assert.equal(db.prepare('SELECT status FROM threads WHERE id = ?').get(thr).status, 'drafted');
  // Even if something closed it anyway, cancelling (内容を編集 / 予約を取り消す) brings the reply back.
  db.prepare("UPDATE threads SET status = 'done' WHERE id = ?").run(thr);
  assert.equal((await call('POST', `/api/sends/${sendId}/undo`, {})).statusCode, 200);
  assert.equal(db.prepare('SELECT status FROM threads WHERE id = ?').get(thr).status, 'drafted');
  assert.equal(new Store(db, biz).draft(draftId).status, 'open');
});
