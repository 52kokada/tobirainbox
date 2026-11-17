// Pre-send suppression check: cockpit decides, Inbox never sends unchecked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { gmailTransport } from '../src/transport.js';
import { leadContextUrl } from '../src/cockpit-check.js';
import { SendRefused } from '../src/send-queue.js';

const masterKey = randomBytes(32).toString('base64');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const inbound = {
  id: 'm1', threadId: 'GT1', labelIds: ['INBOX'], internalDate: '1793840000000',
  payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: '店主 <owner@shop.jp>' }, { name: 'Subject', value: 'Re: 件名' },
    { name: 'Message-ID', value: '<abc@shop.jp>' }, { name: 'Date', value: 'Wed, 4 Nov 2026 10:00:00 +0900' },
  ], body: { data: b64('見てみたいです。') } },
};

function setup({ reports = 1, config: extra = {} } = {}) {
  const db = openDb(':memory:');
  const biz = newId(); const mbx = newId(); const thr = newId();
  db.prepare("INSERT INTO businesses (id, name, status, report_to_cockpit) VALUES (?, 'Example Studio', 'active', ?)").run(biz, reports);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'live', 0)")
    .run(mbx, biz, encrypt('r', masterKey));
  db.prepare("INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status) VALUES (?, ?, ?, 'GT1', 'inquiry', 'new')").run(thr, biz, mbx);
  const sent = [];
  const gmailFactory = () => ({
    getThread: async () => ({ messages: [inbound] }),
    sendRaw: async (raw) => { sent.push(raw); return { id: 'gm-sent-1' }; },
    modifyThread: async () => {}, getMessage: async () => inbound,
  });
  const config = { masterKey, cockpitEventsUrl: 'https://cockpit.example/api/internal/brain/inbox-events', cockpitEventsToken: 'tok', ...extra };
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mbx);
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(thr);
  const run = (fetchImpl) => gmailTransport(db, config, { gmailFactory, fetchImpl }).send({ send: { body_text: 'ありがとうございます。' }, thread, mailbox });
  return { run, sent };
}
const answer = (body, status = 200) => async (url, opts) => { answer.last = { url, opts }; return { ok: status === 200, status, json: async () => body }; };

test('lead-context url is derived from the events url', () => {
  assert.equal(leadContextUrl('https://c.example/api/internal/brain/inbox-events'), 'https://c.example/api/internal/brain/inbox-lead-context');
});

test('allowed recipient is sent, and cockpit is asked about the real recipient', async () => {
  const { run, sent } = setup();
  await run(answer({ send: { allowed: true, reason: null } }));
  assert.equal(sent.length, 1);
  const u = new URL(answer.last.url);
  assert.equal(u.searchParams.get('to_email'), 'owner@shop.jp');
  assert.equal(u.searchParams.get('mailbox'), 'leo@example.com');
  assert.equal(answer.last.opts.headers.authorization, 'Bearer tok');
});

test('suppressed recipient is refused for good and nothing is sent', async () => {
  const { run, sent } = setup();
  await assert.rejects(run(answer({ send: { allowed: false, reason: 'recipient_suppressed' } })), (e) => e instanceof SendRefused && e.code === 'recipient_suppressed');
  assert.equal(sent.length, 0);
});

test('cockpit down, erroring or silent: held, not sent', async () => {
  for (const f of [async () => { throw new Error('ECONNREFUSED'); }, answer({}, 502), answer({ lead: null })]) {
    const { run, sent } = setup();
    await assert.rejects(run(f), (e) => !(e instanceof SendRefused) && /held/.test(e.message));
    assert.equal(sent.length, 0);
  }
});

test('reporting business without cockpit config is held', async () => {
  const { run, sent } = setup({ config: { cockpitEventsUrl: '' } });
  await assert.rejects(run(answer({ send: { allowed: true } })), /not configured/);
  assert.equal(sent.length, 0);
});

test('a business that does not report to cockpit is not checked', async () => {
  const { run, sent } = setup({ reports: 0 });
  await run(async () => { throw new Error('must not be called'); });
  assert.equal(sent.length, 1);
});
