import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Store, newId } from '../src/store.js';
import { queueSend, cancelSend, deliverDue, SendRefused, DEFAULT_UNDO_SECONDS } from '../src/send-queue.js';
import { buildApp } from '../src/app.js';

let db; let a; let b;

function seedBusiness(db, name, { mode = 'live', undo } = {}) {
  const biz = newId(); const user = newId(); const mbx = newId(); const thr = newId();
  db.prepare('INSERT INTO businesses (id, name, status) VALUES (?, ?, ?)').run(biz, name, 'active');
  if (undo != null) db.prepare('UPDATE businesses SET undo_seconds = ? WHERE id = ?').run(undo, biz);
  db.prepare('INSERT INTO users (id, business_id, email, role) VALUES (?, ?, ?, ?)').run(user, biz, `${name}@x.jp`, 'owner');
  db.prepare('INSERT INTO mailboxes (id, business_id, address, mode, status) VALUES (?, ?, ?, ?, ?)').run(mbx, biz, `${name}@x.jp`, mode, 'connected');
  db.prepare('INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_at) VALUES (?, ?, ?, ?, ?)').run(thr, biz, mbx, `g-${name}`, '2026-11-04T00:00:00Z');
  return { biz, user, mbx, thr, store: new Store(db, biz) };
}

beforeEach(() => {
  db = openDb(':memory:');
  a = seedBusiness(db, 'acme');
  b = seedBusiness(db, 'gindendo');
});

test('migrations apply once and default undo window is 30 s', () => {
  assert.equal(a.store.business().undo_seconds, 30);
  assert.equal(DEFAULT_UNDO_SECONDS, 30);
  assert.throws(() => db.prepare('UPDATE businesses SET undo_seconds = 31 WHERE id = ?').run(a.biz), /CHECK/);
});

test('store is business-scoped: no cross-business reads or writes', () => {
  assert.throws(() => new Store(db, ''), /businessId/);
  assert.equal(a.store.thread(b.thr), null);
  assert.equal(a.store.user(b.user), null);
  assert.throws(() => a.store.saveDraft({ threadId: b.thr, bodyText: 'x', createdBy: 'ai' }), /not found/);
  assert.equal(a.store.triage().length, 1);
  assert.equal(a.store.triage()[0].id, a.thr);
});

test('send needs a member of the same business', () => {
  const d = a.store.saveDraft({ threadId: a.thr, bodyText: 'ok', createdBy: 'ai' });
  assert.throws(() => queueSend(a.store, { userId: b.user, draftId: d }), (e) => e instanceof SendRefused && e.code === 'not_a_member');
  assert.throws(() => queueSend(b.store, { userId: b.user, draftId: d }), (e) => e.code === 'no_draft');
});

test('blanks block sending; filling them in the edit unblocks it', () => {
  const d = a.store.saveDraft({ threadId: a.thr, bodyText: '料金は【要確認：金額】です', createdBy: 'ai' });
  assert.throws(() => queueSend(a.store, { userId: a.user, draftId: d }), (e) => e.code === 'blanks_left');
  const r = queueSend(a.store, { userId: a.user, draftId: d, bodyText: '料金は¥24,000です' });
  assert.ok(r.sendId);
  assert.equal(a.store.latestDraft(a.thr).created_by, 'user');
});

test('candidate slots refuse stored drafts and final edits, then allow completed dates', () => {
  const d = a.store.saveDraft({ threadId: a.thr, bodyText: '候補は〇月〇日です。', createdBy: 'ai' });
  assert.throws(() => queueSend(a.store, { userId: a.user, draftId: d }), (e) => e.code === 'blanks_left');
  assert.throws(() => queueSend(a.store, { userId: a.user, draftId: d, bodyText: '11月20日 15:〇〇' }), (e) => e.code === 'blanks_left');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
  assert.ok(queueSend(a.store, { userId: a.user, draftId: d, bodyText: '11月20日 15:30' }).sendId);
});

test('worker refuses legacy queued candidate slots without calling transport or retrying', async () => {
  const d = a.store.saveDraft({ threadId: a.thr, bodyText: '11月20日 15:30', createdBy: 'ai' });
  const { sendId } = queueSend(a.store, { userId: a.user, draftId: d, now: new Date('2026-11-05T00:00:00Z') });
  db.prepare('UPDATE sends SET body_text = ? WHERE id = ?').run('〇月〇日 〇〇:〇〇', sendId);
  let calls = 0;
  const result = await deliverDue(db, { async send() { calls++; return { messageId: 'unexpected' }; } }, { now: new Date('2026-11-05T00:01:00Z') });
  assert.equal(calls, 0);
  assert.equal(result[0].status, 'failed');
  assert.equal(a.store.draft(d).status, 'queued');
});

test('double click queues once', () => {
  const d = a.store.saveDraft({ threadId: a.thr, bodyText: 'ok', createdBy: 'ai' });
  queueSend(a.store, { userId: a.user, draftId: d });
  assert.throws(() => queueSend(a.store, { userId: a.user, draftId: d }), (e) => e.code === 'already_queued');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 1);
});

test('shadow mailbox never sends', () => {
  const s = seedBusiness(db, 'shadowbiz', { mode: 'shadow' });
  const d = s.store.saveDraft({ threadId: s.thr, bodyText: 'ok', createdBy: 'ai' });
  assert.throws(() => queueSend(s.store, { userId: s.user, draftId: d }), (e) => e.code === 'mailbox_not_live');
});

test('nothing leaves inside the 30 s undo window; undo stops it; after the window it sends once', async () => {
  const t0 = new Date('2026-11-05T00:00:00Z');
  const sent = [];
  const transport = { async send({ send }) { sent.push(send.id); return { messageId: `m-${send.id}` }; } };

  const d1 = a.store.saveDraft({ threadId: a.thr, bodyText: 'first', createdBy: 'ai' });
  const q1 = queueSend(a.store, { userId: a.user, draftId: d1, now: t0 });
  assert.equal(q1.undoUntil, '2026-11-05T00:00:30.000Z');
  assert.deepEqual(await deliverDue(db, transport, { now: new Date('2026-11-05T00:00:29Z') }), []);
  cancelSend(a.store, { userId: a.user, sendId: q1.sendId, now: new Date('2026-11-05T00:00:29Z') });
  assert.deepEqual(await deliverDue(db, transport, { now: new Date('2026-11-05T00:01:00Z') }), []);

  const q2 = queueSend(a.store, { userId: a.user, draftId: d1, bodyText: 'second', now: t0 });
  assert.throws(() => cancelSend(a.store, { userId: a.user, sendId: q2.sendId, now: new Date('2026-11-05T00:00:31Z') }), (e) => e.code === 'too_late');
  const r = await deliverDue(db, transport, { now: new Date('2026-11-05T00:00:31Z') });
  assert.deepEqual(r.map((x) => x.status), ['sent']);
  assert.deepEqual(await deliverDue(db, transport, { now: new Date('2026-11-05T00:05:00Z') }), []);
  assert.equal(sent.length, 1);
  assert.equal(a.store.thread(a.thr).status, 'sent');
});

test('business undo setting is used and clamped', () => {
  const s = seedBusiness(db, 'fast', { undo: 5 });
  const d = s.store.saveDraft({ threadId: s.thr, bodyText: 'ok', createdBy: 'ai' });
  const { undoUntil } = queueSend(s.store, { userId: s.user, draftId: d, now: new Date('2026-11-05T00:00:00Z') });
  assert.equal(undoUntil, '2026-11-05T00:00:05.000Z');
});

test('transport failure retries up to 3 times then fails, never double-sends', async () => {
  const d = a.store.saveDraft({ threadId: a.thr, bodyText: 'ok', createdBy: 'ai' });
  queueSend(a.store, { userId: a.user, draftId: d, now: new Date('2026-11-05T00:00:00Z') });
  const bad = { async send() { throw new Error('gmail 503'); } };
  const later = new Date('2026-11-05T00:10:00Z');
  assert.equal((await deliverDue(db, bad, { now: later }))[0].status, 'queued');
  assert.equal((await deliverDue(db, bad, { now: later }))[0].status, 'queued');
  assert.equal((await deliverDue(db, bad, { now: later }))[0].status, 'failed');
  assert.deepEqual(await deliverDue(db, bad, { now: later }), []);
});

test('healthz', async () => {
  const app = buildApp({ db });
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});
