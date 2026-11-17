// Mail from our own side (teammates on the company domain) is never treated as customer mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { ownMatcher } from '../src/ingest.js';

test('teammates on the company domain count as our side; shared webmail does not', () => {
  const db = openDb(':memory:');
  const b = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'T', 'active')").run(b);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, 'mia@example.com', 'x', 'connected', 'live')").run(newId(), b);
  db.prepare("INSERT INTO users (id, business_id, email, name, role) VALUES (?, ?, 'someone@gmail.com', 'S', 'staff')").run(newId(), b);
  const own = ownMatcher(db, b);
  assert.equal(own('jay@example.com'), true);
  assert.equal(own('MORI@example.com'), true);
  assert.equal(own('someone@gmail.com'), true);
  assert.equal(own('other@gmail.com'), false);
  assert.equal(own('info@smile.example'), false);
});

test('migration takes threads last written by a teammate out of 要対応', () => {
  const db = openDb(':memory:');
  const b = newId(); const m = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'T', 'active')").run(b);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, 'mia@example.com', 'x', 'connected', 'live')").run(m, b);
  const ins = db.prepare("INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from) VALUES (?, ?, ?, ?, 'inquiry', 'drafted', ?)");
  ins.run('t1', b, m, 'g1', 'Jay Kuma <jay@example.com>');
  ins.run('t2', b, m, 'g2', 'Client <info@client.jp>');
  db.exec(require_sql());
  const st = Object.fromEntries(db.prepare('SELECT id, status FROM threads').all().map((r) => [r.id, r.status]));
  assert.deepEqual(st, { t1: 'done', t2: 'drafted' });
});

import { readFileSync } from 'node:fs';
function require_sql() { return readFileSync(new URL('../migrations/0010_internal_threads_done.sql', import.meta.url), 'utf8'); }

test('history picks up new inbox mail and mail moved into the inbox (e.g. rescued from spam)', async () => {
  const { Gmail } = await import('../src/gmail.js');
  const g = new Gmail({ clientId: 'c', clientSecret: 's', refreshToken: 'r' });
  let asked;
  g.call = async (_m, path) => { asked = path; return { historyId: '9', history: [
    { messagesAdded: [{ message: { id: 'new1' } }] },
    { labelsAdded: [{ message: { id: 'spam1' }, labelIds: ['INBOX'] }, { message: { id: 'star1' }, labelIds: ['STARRED'] }] },
  ] }; };
  const h = await g.historySince('1');
  assert.deepEqual(h.messageIds, ['new1', 'spam1']);
  assert.match(asked, /historyTypes=messageAdded&historyTypes=labelAdded/);
});

test('a Gmail emoji reaction is recognised (never answered, never counts as our reply)', async () => {
  const { parseMessage } = await import('../src/gmail.js');
  const m = parseMessage({ id: 'r', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: 'Gus <mia@example.com>' }],
    parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('❤️').toString('base64url') } }, { mimeType: 'text/vnd.google.email-reaction+json', body: { data: '' } }] } });
  assert.equal(m.reaction, true);
  assert.equal(parseMessage({ id: 'n', payload: { mimeType: 'text/plain', headers: [], body: { data: '' } } }).reaction, false);
});
