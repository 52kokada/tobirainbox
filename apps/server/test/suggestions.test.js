// Calendar plan step 9: suggestions from detected dates (upsert, supersede, thread linking, labels, sub-cap).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import {
  counterpartLabel, prepareDetection, recordSuggestions, linkSuggestions, underDateSubCap, detectionContext, DATE_SUBCAP_SHARE,
} from '../src/suggestions.js';

let db; let biz; let mbx;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); mbx = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_mode, ai_daily_cap_usd) VALUES (?, 'Tobira', 'active', 'shadow', 1)").run(biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, 'leo@example.com', 'x', 'connected', 'shadow')").run(mbx, biz);
});
const mailbox = () => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mbx);
const own = (a) => a.endsWith('@example.com');
const msg = (o = {}) => ({ id: 'm1', threadId: 'gt', labelIds: ['INBOX'], from: '佐藤 <sato@acme.co.jp>', to: 'leo@example.com', cc: '', body: '', ...o });
const prep = (o = {}) => ({ direction: 'theirs', counterpart: 'Acme', sentAt: '2026-11-06T01:00:00.000Z', ...o });
const date = (startUtc, kind = 'offer') => ({ startUtc, endUtc: new Date(Date.parse(startUtc) + 1800_000).toISOString(), tz: 'Asia/Tokyo', tzSource: 'business', kind, quote: '11/9 10:00 tanaka@acme.co.jp 090-1234-5678' });
const rows = () => db.prepare('SELECT * FROM suggestions ORDER BY message_at, start_utc').all();

test('counterpart label: display name, else domain; never an address; at most 40 chars', () => {
  const cases = [
    [msg(), 'theirs', '佐藤'],
    [msg({ from: 'sato@acme.co.jp' }), 'theirs', 'acme.co.jp'],
    [msg({ from: '"sato@acme.co.jp" <sato@acme.co.jp>' }), 'theirs', 'acme.co.jp'],
    [msg({ from: '"Sato, Ken" <sato@acme.co.jp>' }), 'theirs', 'Sato, Ken'],
    [msg({ from: 'Leo <leo@example.com>', to: 'Gus <gus@example.com>, "Lee, Ann" <ann@corp.example>' }), 'ours', 'Lee, Ann'],
    [msg({ from: 'leo@example.com', to: 'gus@example.com', cc: 'bob@corp.example' }), 'ours', 'corp.example'],
    [msg({ from: `${'あ'.repeat(60)} <a@b.jp>` }), 'theirs', 'あ'.repeat(40)],
    [msg({ from: 'contact me at x@y.com <x@y.com>' }), 'theirs', 'y.com'],
    [msg({ from: 'Weird x@evil.com Name <a@b.co>' }), 'theirs', null],
  ];
  for (const [m, dir, want] of cases) {
    const got = counterpartLabel(m, dir, own);
    assert.ok(got === null || !got.includes('@'), `no address in ${got}`);
    assert.ok(got === null || got.length <= 40);
    if (want !== null) assert.equal(got, want);
  }
  assert.equal(counterpartLabel(msg({ from: 'leo@example.com', to: 'gus@example.com' }), 'ours', own), null);
});

test('prepareDetection: direction from SENT or own address; reactions, spam, bulk and auto-replies skipped', () => {
  assert.equal(prepareDetection(msg({ body: '11/9 10時' }), {}, { isOwn: own }).direction, 'theirs');
  assert.equal(prepareDetection(msg({ labelIds: ['SENT'], body: 'x' }), {}, { isOwn: own }).direction, 'ours');
  assert.equal(prepareDetection(msg({ from: 'leo@example.com', body: 'x' }), {}, { isOwn: own }).direction, 'ours');
  assert.equal(prepareDetection(msg({ reaction: true }), {}), null);
  assert.equal(prepareDetection(msg({ labelIds: ['SPAM'] }), {}), null);
  assert.equal(prepareDetection(msg({ listUnsubscribe: '<x>' }), {}), null);
  assert.equal(prepareDetection(msg({ autoSubmitted: 'auto-replied' }), {}), null);
  assert.equal(prepareDetection(msg({ body: '資料をお送りします' }), {}).hint, false);
  assert.equal(prepareDetection(msg({ body: '来週火曜14時はいかが' }), {}).hint, true);
});

test('upsert by message + start; quote redacted; later mail supersedes earlier suggested rows, held ones stay', () => {
  const a = recordSuggestions(db, { mailbox: mailbox(), msg: msg({ id: 'm1' }), prep: prep(), source: 'ai', dates: [date('2026-11-09T01:00:00.000Z'), date('2026-11-10T01:00:00.000Z')], businessTz: 'Asia/Tokyo' });
  assert.equal(a.length, 2);
  assert.ok(!a[0].quote_redacted.includes('@'));
  assert.ok(!a[0].quote_redacted.includes('090-1234-5678'));
  // Same message again: no duplicate.
  recordSuggestions(db, { mailbox: mailbox(), msg: msg({ id: 'm1' }), prep: prep(), source: 'ai', dates: [date('2026-11-09T01:00:00.000Z')], businessTz: 'Asia/Tokyo' });
  assert.equal(rows().length, 2);
  db.prepare("UPDATE suggestions SET state = 'held' WHERE start_utc = '2026-11-10T01:00:00.000Z'").run();

  recordSuggestions(db, { mailbox: mailbox(), msg: msg({ id: 'm2' }), prep: prep({ sentAt: '2026-11-07T01:00:00.000Z' }), source: 'ai', dates: [date('2026-11-09T01:00:00.000Z', 'confirm')], businessTz: 'Asia/Tokyo' });
  assert.deepEqual(rows().map((r) => [r.gmail_message_id, r.state]), [['m1', 'superseded'], ['m1', 'held'], ['m2', 'suggested']]);

  // An older message detected late (next-day retry) never supersedes newer rows; it is stored superseded.
  recordSuggestions(db, { mailbox: mailbox(), msg: msg({ id: 'm0' }), prep: prep({ sentAt: '2026-11-05T01:00:00.000Z' }), source: 'ai', dates: [date('2026-11-12T01:00:00.000Z')], businessTz: 'Asia/Tokyo' });
  assert.equal(rows().find((r) => r.gmail_message_id === 'm0').state, 'superseded');
  assert.equal(rows().find((r) => r.gmail_message_id === 'm2').state, 'suggested');
});

test('thread_id is set when a thread row exists, otherwise linked later; a stated zone is kept, a business-zone date has none', () => {
  const [s] = recordSuggestions(db, { mailbox: mailbox(), msg: msg(), prep: prep(), source: 'ai', dates: [date('2026-11-09T01:00:00.000Z')], businessTz: 'Asia/Tokyo' });
  assert.equal(s.thread_id, null);
  assert.equal(s.stated_tz, null);
  const tid = newId();
  db.prepare("INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, status) VALUES (?, ?, ?, 'gt', 'm1', 'new')").run(tid, biz, mbx);
  assert.equal(linkSuggestions(db, { mailboxId: mbx, gmailThreadId: 'gt', threadId: tid }), 1);
  const [t] = recordSuggestions(db, { mailbox: mailbox(), msg: msg({ id: 'm9' }), prep: prep({ sentAt: '2026-11-08T00:00:00.000Z' }), source: 'ai',
    dates: [{ ...date('2026-11-09T23:00:00.000Z'), tz: 'America/Los_Angeles', tzSource: 'stated' }], businessTz: 'Asia/Tokyo' });
  assert.equal(t.thread_id, tid);
  assert.equal(t.stated_tz, 'America/Los_Angeles');
});

test('sub-cap is 30% of the business cap, and the whole cap still binds; cap 0 means no cap; mode off gives no context', () => {
  assert.equal(DATE_SUBCAP_SHARE, 0.3);
  assert.equal(underDateSubCap(db, biz, 0.5), true);
  db.prepare("INSERT INTO ai_usage (business_id, operation, model, cost_usd) VALUES (?, 'dates', 'm', 0.29)").run(biz);
  assert.equal(underDateSubCap(db, biz, 0.5), true);
  db.prepare("INSERT INTO ai_usage (business_id, operation, model, cost_usd) VALUES (?, 'dates', 'm', 0.02)").run(biz);
  assert.equal(underDateSubCap(db, biz, 0.5), false);
  db.prepare("DELETE FROM ai_usage").run();
  db.prepare("INSERT INTO ai_usage (business_id, operation, model, cost_usd) VALUES (?, 'sort', 'm', 1.0)").run(biz);
  assert.equal(underDateSubCap(db, biz, 0.5), false);
  db.prepare('UPDATE businesses SET ai_daily_cap_usd = 0').run();
  assert.equal(underDateSubCap(db, biz, 0.5), true);
  db.prepare("UPDATE businesses SET calendar_mode = 'off'").run();
  assert.equal(detectionContext(db, biz), null);
});
