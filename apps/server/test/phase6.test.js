import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId, Store } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { emit, flushOutbox, outreachVerdict } from '../src/cockpit-outbox.js';
import { relabelThread } from '../src/mailboxes.js';
import { queueSend, deliverDue } from '../src/send-queue.js';

const masterKey = randomBytes(32).toString('base64');
let db; let biz; let mbx; let thr; let user; let other;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); mbx = newId(); thr = newId(); user = newId(); other = newId();
  db.prepare("INSERT INTO businesses (id, name, status, report_to_cockpit) VALUES (?, 'Example Studio', 'active', 1)").run(biz);
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Acme Shop', 'active')").run(other);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'leo@example.com', 'owner')").run(user, biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'live', 0)").run(mbx, biz, encrypt('r', masterKey));
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, label_key, status, cache_from)
    VALUES (?, ?, ?, 'G1', 'M1', 'inquiry', 'new', '森田 <info@sample-kitchen.jp>')`).run(thr, biz, mbx);
});

test('verdict mapping matches cockpit vocabulary', () => {
  assert.equal(outreachVerdict('question'), 'positive');
  assert.equal(outreachVerdict('optout'), 'optout');
  assert.equal(outreachVerdict('unconfirmed'), 'unclear');
  assert.equal(outreachVerdict('notice'), null);
});

test('only companies that report to cockpit queue events', () => {
  assert.equal(emit(db, { businessId: other, type: 'sorted', label: 'inquiry' }), false);
  assert.equal(emit(db, { businessId: biz, type: 'sorted', label: 'inquiry', from: 'X <a@b.jp>' }), true);
  assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM outbox_events').get().payload_json).fromEmail, 'a@b.jp');
});

test('relabel queues a relabelled event; a send queues a sent event with the Message-ID headers', async () => {
  await relabelThread({ db, config: {}, threadId: thr, businessId: biz, to: 'optout', userId: user });
  const store = new Store(db, biz);
  const d = store.saveDraft({ threadId: thr, bodyText: 'ok', createdBy: 'ai' });
  queueSend(store, { userId: user, draftId: d, now: new Date(Date.now() - 60_000) });
  const transport = { send: async () => ({ messageId: 'gm1', messageIdHeader: '<new@mail.gmail.com>', inReplyTo: '<abc@sample-kitchen.jp>', to: 'info@sample-kitchen.jp', replyingTo: 'M1' }) };
  await deliverDue(db, transport, { onSent: ({ send, thread, mailbox, delivered }) => emit(db, { businessId: send.business_id, type: 'sent', mailbox: mailbox.address, thread: thread.gmail_thread_id, gmailMessageId: delivered.messageId, label: thread.label_key, extra: { messageIdHeader: delivered.messageIdHeader, inReplyTo: delivered.inReplyTo } }) });
  const ev = db.prepare('SELECT type, payload_json FROM outbox_events ORDER BY id').all().map((r) => ({ type: r.type, ...JSON.parse(r.payload_json) }));
  assert.deepEqual(ev.map((e) => e.type), ['relabelled', 'sent']);
  assert.equal(ev[0].outreachVerdict, 'optout');
  assert.equal(ev[0].previousLabel, 'inquiry');
  assert.equal(ev[1].messageIdHeader, '<new@mail.gmail.com>');
  assert.equal(ev[1].inReplyTo, '<abc@sample-kitchen.jp>');
});

test('flush: inert until configured; delivers in order with stable eventIds; failures stay pending', async () => {
  emit(db, { businessId: biz, type: 'sorted', label: 'inquiry' });
  emit(db, { businessId: biz, type: 'sorted', label: 'decline' });
  assert.deepEqual(await flushOutbox(db, {}), { skipped: 'not configured' });
  const cfg = { cockpitEventsUrl: 'https://cockpit.example/api/internal/brain/inbox-events', cockpitEventsToken: 't' };
  const bad = await flushOutbox(db, cfg, { fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.match(bad.error, /503/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox_events WHERE status = 'pending' AND attempts = 1").get().n, 2);
  let body;
  const ok = await flushOutbox(db, cfg, { fetchImpl: async (url, o) => { body = JSON.parse(o.body); assert.equal(o.headers.authorization, 'Bearer t'); return { ok: true }; } });
  assert.equal(ok.delivered, 2);
  assert.deepEqual(body.events.map((e) => e.eventId), ['tobira-inbox:1', 'tobira-inbox:2']);
  assert.equal((await flushOutbox(db, cfg, { fetchImpl: async () => ({ ok: true }) })).delivered, 0);
});
