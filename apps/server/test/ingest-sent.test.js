// Calendar plan step 9: date detection at ingest, incoming and sent mail, under the date sub-cap.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { createAi } from '../src/ai.js';
import { ingestMailbox, retryDeferredDates } from '../src/ingest.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'cid', clientSecret: 'sec', masterKey, drafting: false, aiDailyCapUsd: 1 };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const SENT_AT = Date.parse('2026-11-06T01:00:00Z'); // Fri 10:00 JST

function gmailMsg({ id, threadId = `t-${id}`, from = '田中 <tanaka@client.co.jp>', to = 'leo@example.com', subject = 'お打ち合わせ', body, labels = ['INBOX'], extraHeaders = [], extraParts = [] }) {
  return {
    id, threadId, labelIds: labels, snippet: body.slice(0, 50), internalDate: String(SENT_AT),
    payload: { mimeType: 'multipart/mixed', headers: [
      { name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@x>` }, ...extraHeaders,
    ], parts: [{ mimeType: 'text/plain', body: { data: b64(body) } }, ...extraParts] },
  };
}

function fakeGmail(messages, { inbox = [], sent = [] } = {}) {
  const calls = { sentHistory: 0, get: [] };
  return {
    calls,
    profile: async () => ({ historyId: '900' }),
    listInbox: async () => inbox,
    historySince: async () => ({ messageIds: inbox, historyId: '900' }),
    sentHistorySince: async () => { calls.sentHistory += 1; return { messageIds: sent, historyId: '900' }; },
    getMessage: async (id) => { calls.get.push(id); return messages[id]; },
    labels: async () => [],
    createLabel: async (name) => ({ id: name, name }),
    modifyThread: async () => {},
  };
}

/** Fake ai.complete: sorting answers a label, date detection answers `dates` (and costs `dateCost`). */
function fakeAi({ dates = [], dateCost = 0.001 } = {}) {
  const calls = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      if (req.operation === 'dates') return { text: JSON.stringify({ dates }), model: 'claude-haiku-5-5', tokens_in: 900, tokens_out: 40, cost_usd: dateCost };
      return { text: '{"label":"booking","confidence":0.9}', model: 'claude-haiku-5-5', tokens_in: 100, tokens_out: 10, cost_usd: 0.00002 };
    },
  };
}
const OFFER = [{ start: '2026-11-09T10:00', end: null, tz: null, kind: 'offer', quote: '11/9(月)10:00〜' }];

let db; let biz; let mbx;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); mbx = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_mode, ai_daily_cap_usd) VALUES (?, 'Tobira', 'active', 'shadow', 1)").run(biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, history_id) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'shadow', '100')")
    .run(mbx, biz, encrypt('refresh-1', masterKey));
});
const mailbox = () => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mbx);
const suggestions = () => db.prepare('SELECT * FROM suggestions WHERE business_id = ? ORDER BY start_utc').all(biz);
const setMode = (m) => db.prepare('UPDATE businesses SET calendar_mode = ? WHERE id = ?').run(m, biz);
const run = (gmail, ai) => ingestMailbox({ db, mailbox: mailbox(), ai, config, gmailFactory: () => gmail });

test('a sent message with no thread row makes an ours suggestion with thread_id NULL; a later inbox message on that thread fills it', async () => {
  const sent = gmailMsg({ id: 's1', threadId: 'gt1', from: 'Leo <leo@example.com>', to: '田中 太郎 <tanaka@client.co.jp>', labels: ['SENT'], body: '11/9(月)10:00〜はいかがでしょうか。' });
  const ai = fakeAi({ dates: OFFER });
  const r = await run(fakeGmail({ s1: sent }, { sent: ['s1'] }), ai);
  assert.equal(r.sorted, 0);
  const [s] = suggestions();
  assert.equal(s.thread_id, null);
  assert.equal(s.gmail_thread_id, 'gt1');
  assert.equal(s.direction, 'ours');
  assert.equal(s.source, 'ai');
  assert.equal(s.kind, 'offer');
  assert.equal(s.start_utc, '2026-11-09T01:00:00.000Z');
  assert.equal(s.end_utc, '2026-11-09T01:30:00.000Z'); // D38: 30 minutes
  assert.equal(s.business_tz, 'Asia/Tokyo');
  assert.equal(s.stated_tz, null);
  assert.equal(s.counterpart_label, '田中 太郎');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM threads').get().n, 0);

  const reply = gmailMsg({ id: 'i1', threadId: 'gt1', body: 'ありがとうございます。社内で確認します。' });
  await run(fakeGmail({ i1: reply }, { inbox: ['i1'] }), fakeAi());
  const thread = db.prepare("SELECT id FROM threads WHERE gmail_thread_id = 'gt1'").get();
  assert.ok(thread);
  assert.equal(suggestions()[0].thread_id, thread.id);
});

test('own and sent messages still mark the thread done exactly as before; sent-only ids leave triage untouched', async () => {
  const first = gmailMsg({ id: 'i1', threadId: 'gt2', body: 'ご予約できますか' });
  await run(fakeGmail({ i1: first }, { inbox: ['i1'] }), fakeAi());
  assert.equal(db.prepare("SELECT status FROM threads WHERE gmail_thread_id = 'gt2'").get().status, 'new');

  // A sent message seen only through SENT history: detection only, status unchanged (as with mode off).
  const sentOnly = gmailMsg({ id: 's2', threadId: 'gt2', from: 'leo@example.com', labels: ['SENT'], body: 'お待ちしております' });
  await run(fakeGmail({ s2: sentOnly }, { sent: ['s2'] }), fakeAi());
  assert.equal(db.prepare("SELECT status FROM threads WHERE gmail_thread_id = 'gt2'").get().status, 'new');

  // An own message in INBOX history marks it done, as it always did.
  const own = gmailMsg({ id: 'o1', threadId: 'gt2', from: 'leo@example.com', labels: ['INBOX', 'SENT'], body: '承知しました' });
  await run(fakeGmail({ o1: own }, { inbox: ['o1'], sent: ['o1'] }), fakeAi());
  assert.equal(db.prepare("SELECT status FROM threads WHERE gmail_thread_id = 'gt2'").get().status, 'done');
  assert.equal(db.prepare("SELECT outcome FROM seen_messages WHERE gmail_message_id = 'o1'").get().outcome, 'own');
});

test("calendar_mode 'off': SENT history is not read, no detection, no model call for dates, no rows", async () => {
  setMode('off');
  const inbox = gmailMsg({ id: 'i3', body: '来週火曜14時はいかがでしょうか' });
  const gmail = fakeGmail({ i3: inbox, s3: gmailMsg({ id: 's3', labels: ['SENT'], from: 'leo@example.com', body: '11/9 10時' }) }, { inbox: ['i3'], sent: ['s3'] });
  const ai = fakeAi({ dates: OFFER });
  const r = await run(gmail, ai);
  assert.equal(r.sorted, 1);
  assert.equal(gmail.calls.sentHistory, 0);
  assert.deepEqual(gmail.calls.get, ['i3']);
  assert.equal(ai.calls.filter((c) => c.operation === 'dates').length, 0);
  assert.equal(suggestions().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM date_detections').get().n, 0);
  const dd = await retryDeferredDates({ db, ai, config, gmailFactory: () => gmail });
  assert.deepEqual(dd, { retried: 0, failed: 0 });
});

test('the date sub-cap, checked after sorting, stops detection but not sorting; the id is retried the next day', async () => {
  // 0.3 of the $1 cap is already spent on dates today; total spend is under the cap, so sorting runs.
  db.prepare("INSERT INTO ai_usage (business_id, operation, model, cost_usd) VALUES (?, 'dates', 'claude-haiku-5-5', 0.3)").run(biz);
  const msg = gmailMsg({ id: 'i4', threadId: 'gt4', body: '11/9(月)10:00〜でいかがでしょうか' });
  const gmail = fakeGmail({ i4: msg }, { inbox: ['i4'] });
  const ai = fakeAi({ dates: OFFER });
  const r = await run(gmail, ai);
  assert.equal(r.sorted, 1);
  assert.equal(ai.calls.filter((c) => c.operation === 'sort').length, 1);
  assert.equal(ai.calls.filter((c) => c.operation === 'dates').length, 0);
  assert.equal(r.datesDeferred, 1);
  assert.equal(suggestions().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM date_detection_deferred').get().n, 1);

  // Same day: nothing retried.
  assert.deepEqual(await retryDeferredDates({ db, ai, config, gmailFactory: () => gmail }), { retried: 0, failed: 0 });
  // Next day: today's date spend is zero again (old row moved to yesterday), the message is fetched and detected.
  db.prepare("UPDATE ai_usage SET at = '2000-01-01T00:00:00Z'").run();
  db.prepare("UPDATE date_detection_deferred SET deferred_at = '2000-01-01T00:00:00Z'").run();
  const dd = await retryDeferredDates({ db, ai, config, gmailFactory: () => gmail });
  assert.deepEqual(dd, { retried: 1, failed: 0 });
  assert.equal(suggestions().length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM date_detection_deferred').get().n, 0);
});

test('a pre-filter miss makes no model call; shadow mode logs the decision without body', async () => {
  const msg = gmailMsg({ id: 'i5', subject: 'ご質問', body: '資料をありがとうございました。拝見します。' });
  const ai = fakeAi({ dates: OFFER });
  await run(fakeGmail({ i5: msg }, { inbox: ['i5'] }), ai);
  assert.equal(ai.calls.filter((c) => c.operation === 'dates').length, 0);
  const log = db.prepare('SELECT * FROM date_detections').all();
  assert.equal(log.length, 1);
  assert.equal(log[0].prefilter_hit, 0);
  assert.equal(log[0].result_json, null);
});

test("ai_usage rows from date detection carry operation 'dates', low effort and the cached system block", async () => {
  const seen = [];
  const client = { messages: { create: async (p) => {
    seen.push(p);
    const isDates = p.system?.[0]?.text?.startsWith('Find the meeting dates');
    return { id: 'msg_1', model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 20 },
      content: [{ type: 'text', text: isDates ? JSON.stringify({ dates: OFFER }) : '{"label":"booking","confidence":0.9}' }] };
  } } };
  const ai = createAi({ client, db });
  const msg = gmailMsg({ id: 'i6', body: '11/9(月)10:00〜でいかがでしょうか' });
  await run(fakeGmail({ i6: msg }, { inbox: ['i6'] }), ai);
  const ops = db.prepare('SELECT operation FROM ai_usage WHERE business_id = ? ORDER BY id').all(biz).map((r) => r.operation);
  assert.ok(ops.includes('dates'));
  const datesCall = seen.find((p) => p.system?.[0]?.text?.startsWith('Find the meeting dates'));
  assert.deepEqual(datesCall.output_config, { effort: 'low' });
  assert.deepEqual(datesCall.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(datesCall.model, 'claude-haiku-5-5');
  assert.equal(suggestions().length, 1);
});

test('reactions and bulk mail are skipped by detection; a .ics invite is parsed directly with no model call', async () => {
  const ics = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:abc@google.com', 'DTSTART;TZID=Asia/Tokyo:20261110T140000',
    'DTEND;TZID=Asia/Tokyo:20261110T150000', 'SUMMARY:打ち合わせ', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const invite = gmailMsg({ id: 'i7', threadId: 'gt7', body: '招待状', extraParts: [{ mimeType: 'text/calendar', body: { data: b64(ics) } }] });
  const bulk = gmailMsg({ id: 'i8', body: '11/9 10時からセミナー開催', extraHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:x@y>' }] });
  const ai = fakeAi({ dates: OFFER });
  await run(fakeGmail({ i7: invite, i8: bulk }, { inbox: ['i7', 'i8'] }), ai);
  assert.equal(ai.calls.filter((c) => c.operation === 'dates').length, 0);
  const s = suggestions();
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].source, s[0].kind, s[0].direction, s[0].start_utc, s[0].end_utc, s[0].stated_tz],
    ['invite', 'confirm', 'theirs', '2026-11-10T05:00:00.000Z', '2026-11-10T06:00:00.000Z', 'Asia/Tokyo']);
});

test('a detection failure never stops sorting', async () => {
  const msg = gmailMsg({ id: 'i9', body: '11/9(月)10:00〜でいかがでしょうか' });
  const ai = { calls: [], async complete(req) { if (req.operation === 'dates') throw new Error('api down'); return { text: '{"label":"booking","confidence":0.9}', model: 'claude-haiku-5-5', cost_usd: 0 }; } };
  const r = await run(fakeGmail({ i9: msg }, { inbox: ['i9'] }), ai);
  assert.equal(r.sorted, 1);
  assert.equal(r.dateErrors, 1);
  assert.equal(r.errors, 0);
});
