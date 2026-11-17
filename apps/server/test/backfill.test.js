// Full history: every conversation lands in 履歴 (sent / done), never in 要対応; own-only outreach is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { backfillMailbox } from '../src/backfill.js';

const h = (name, value) => ({ name, value });
const msg = (id, from, labels, subject = '相談') => ({ id, labelIds: labels, internalDate: String(Date.now()), snippet: 's', payload: { mimeType: 'text/plain', headers: [h('From', from), h('Subject', subject), h('Message-ID', `<${id}@x>`)] } });

test('backfill: conversations become 送信済み / 完了, our-only outreach is skipped, nothing reaches 要対応', async () => {
  const db = openDb(':memory:'); const b = newId(); const m = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'T', 'active')").run(b);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, 'mia@example.com', 'x', 'connected', 'live')").run(m, b);
  const threads = {
    A: [msg('a1', 'Client <c@client.jp>', ['INBOX']), msg('a2', 'mia@example.com', ['SENT'])],
    B: [msg('b1', 'mia@example.com', ['SENT']), msg('b2', 'Shop <s@shop.jp>', ['INBOX'])],
    C: [msg('c1', 'mia@example.com', ['SENT'])],
  };
  const gmail = { call: async (_m, path) => (path.startsWith('/threads?') ? { threads: Object.keys(threads).map((id) => ({ id })) } : { messages: threads[path.match(/\/threads\/(\w+)/)[1]] }) };
  const ai = { complete: async () => ({ text: 'inquiry 0.9' }) };
  const r = await backfillMailbox({ db, mailbox: db.prepare('SELECT * FROM mailboxes').get(), gmail, ai, config: { aiDailyCapUsd: 5 } });
  assert.deepEqual([r.added, r.noInbound], [2, 1]);
  const st = Object.fromEntries(db.prepare('SELECT gmail_thread_id g, status FROM threads').all().map((x) => [x.g, x.status]));
  assert.deepEqual(st, { A: 'sent', B: 'done' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM seen_messages WHERE outcome = 'skipped'").get().n, 2);
  const again = await backfillMailbox({ db, mailbox: db.prepare('SELECT * FROM mailboxes').get(), gmail, ai, config: {} });
  assert.equal(again.added, 0);
});
