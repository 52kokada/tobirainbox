// Calendar deadlines (grill round 10): D54 detection in the date call, D55 due date, D56 display,
// D57 auto-close and the publish hook, D58 a general type with only 'preview' on; dark for mode 'off'.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { ingestMailbox } from '../src/ingest.js';
import { closeForClient, DEADLINE_TYPES } from '../src/deadlines.js';
import { fakeGoogle } from './fake-calendar.js';

const masterKey = randomBytes(32).toString('base64');
const ADMIN = 'admin-token-very-secret-1234567890';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const SENT_AT = Date.parse('2026-11-06T01:00:00Z'); // Fri 10:00 JST

function gmailMsg({ id, threadId = `t-${id}`, from = '田中 <tanaka@client.co.jp>', to = 'leo@example.com', subject = 'ご提案', body, labels = ['INBOX'] }) {
  return {
    id, threadId, labelIds: labels, snippet: body.slice(0, 50), internalDate: String(SENT_AT),
    payload: { mimeType: 'multipart/mixed', headers: [
      { name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@x>` },
    ], parts: [{ mimeType: 'text/plain', body: { data: b64(body) } }] },
  };
}
function fakeGmail(messages, { inbox = [], sent = [] } = {}) {
  return {
    profile: async () => ({ historyId: '900' }), listInbox: async () => inbox,
    historySince: async () => ({ messageIds: inbox, historyId: '900' }),
    sentHistorySince: async () => ({ messageIds: sent, historyId: '900' }),
    getMessage: async (id) => messages[id], labels: async () => [], createLabel: async (name) => ({ id: name, name }), modifyThread: async () => {},
  };
}
/** Sorting answers a label; the date call answers `reply` (dates + preview in one JSON). */
function fakeAi(reply = { dates: [] }) {
  const calls = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      if (req.operation === 'dates') return { text: JSON.stringify(reply), model: 'claude-haiku-5-5', tokens_in: 900, tokens_out: 40, cost_usd: 0.001 };
      return { text: '{"label":"inquiry","confidence":0.9}', model: 'claude-haiku-5-5', tokens_in: 100, tokens_out: 10, cost_usd: 0.00002 };
    },
  };
}

let db; let biz; let mbx; let owner; let staff; let g;
const config = { clientId: 'c', clientSecret: 's', masterKey, adminToken: ADMIN, drafting: false, aiDailyCapUsd: 1, publicUrl: 'https://inbox.example.com' };
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); mbx = newId(); owner = newId(); staff = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_mode, ai_daily_cap_usd) VALUES (?, 'Tobira', 'active', 'shadow', 1)").run(biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, history_id) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'shadow', '100')")
    .run(mbx, biz, encrypt('refresh-1', masterKey));
  db.prepare("INSERT INTO users (id, business_id, email, name, role) VALUES (?, ?, 'leo@example.com', 'Leo', 'owner')").run(owner, biz);
  db.prepare("INSERT INTO users (id, business_id, email, name, role) VALUES (?, ?, 'gus@example.com', 'Gus', 'staff')").run(staff, biz);
  config.managerBusinessId = biz;
  g = fakeGoogle();
});
const mailbox = () => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mbx);
const deadlines = () => db.prepare('SELECT * FROM deadlines WHERE business_id = ? ORDER BY created_at').all(biz);
const setMode = (m) => db.prepare('UPDATE businesses SET calendar_mode = ? WHERE id = ?').run(m, biz);
const ingest = (gmail, ai) => ingestMailbox({ db, mailbox: mailbox(), ai, config, gmailFactory: () => gmail });
const WANT = { dates: [], preview: { due: null, quote: 'プレビューを見てみたいです' } };

async function previewFromClient({ id = 'r1', threadId = 'gt1', body = 'ぜひプレビューを見てみたいです。', reply = WANT, from } = {}) {
  const ai = fakeAi(reply);
  await ingest(fakeGmail({ [id]: gmailMsg({ id, threadId, body, ...(from ? { from } : {}) }) }, { inbox: [id] }), ai);
  return ai;
}

test('D54: a client asking for a preview becomes one suggestion via the date call; no second AI call; rule date (D55)', async () => {
  const ai = await previewFromClient();
  assert.equal(ai.calls.filter((c) => c.operation === 'dates').length, 1, 'the preview question rides on the date call');
  assert.ok(ai.calls.every((c) => c.operation !== 'preview'));
  const [d] = deadlines();
  assert.equal(d.type, 'preview'); assert.equal(d.state, 'open'); assert.equal(d.confirmed_at, null, 'a suggestion until someone clicks');
  assert.equal(d.due_date, '2026-11-09'); assert.equal(d.source, 'rule');
  assert.equal(d.client_label, '田中'); assert.ok(!d.client_label.includes('@'));
  assert.equal(d.client_address, 'tanaka@client.co.jp');
  assert.ok(d.thread_id, 'linked to the thread row');
  assert.ok(DEADLINE_TYPES.includes('preview') && DEADLINE_TYPES.length === 1, 'D58: only preview is on');
  // A second "still keen" mail on the same thread adds nothing.
  await previewFromClient({ id: 'r2' });
  assert.equal(deadlines().length, 1);
});

test('D55: a date the client names wins; a past one is read as a slip', async () => {
  await previewFromClient({ body: 'サンプルサイト、11月20日までにお願いできますか。', reply: { dates: [], preview: { due: '2026-11-20' } } });
  assert.equal(deadlines()[0].due_date, '2026-11-20'); assert.equal(deadlines()[0].source, 'mail_date');
  await previewFromClient({ id: 'r9', threadId: 'gt9', reply: { dates: [], preview: { due: '2026-10-01' } } });
  assert.equal(deadlines()[1].due_date, '2026-11-09'); assert.equal(deadlines()[1].source, 'rule');
});

test('our own mail never makes a preview deadline, and mail without preview or date words makes no AI call', async () => {
  const ai = fakeAi(WANT);
  const sent = gmailMsg({ id: 's1', threadId: 'gt1', from: 'Leo <leo@example.com>', to: '田中 <tanaka@client.co.jp>', labels: ['SENT'], body: '無料でプレビューをお作りできます。' });
  const plain = gmailMsg({ id: 'r1', body: '資料ありがとうございました。社内で検討いたします。' });
  await ingest(fakeGmail({ s1: sent, r1: plain }, { inbox: ['r1'], sent: ['s1'] }), ai);
  assert.equal(deadlines().length, 0);
  assert.equal(ai.calls.filter((c) => c.operation === 'dates').length, 0);
});

test('mode off: no detection, no deadline, routes 404, admin hook 409', async () => {
  setMode('off');
  const ai = await previewFromClient();
  assert.equal(ai.calls.filter((c) => c.operation === 'dates').length, 0);
  assert.equal(deadlines().length, 0);
  const a = buildApp({ db, config, calendarClientFor: g.clientFor });
  assert.equal((await a.inject({ method: 'POST', url: `/admin/businesses/${biz}/deadlines/close?key=${ADMIN}`, payload: { client: 'client.co.jp' } })).statusCode, 409);
  assert.equal((await a.inject({ method: 'GET', url: '/api/manager/calendar', headers: { authorization: `Bearer ${ADMIN}` } })).statusCode, 404);
});

test('D57: our sent mail with a Tobira preview link closes it (same thread, or same client domain on another thread)', async () => {
  await previewFromClient();
  await previewFromClient({ id: 'r5', threadId: 'gt5', from: '佐藤 <sato@client.co.jp>' });
  await previewFromClient({ id: 'r6', threadId: 'gt6', from: 'Ann <ann@gmail.com>' });
  const ai = fakeAi();
  const noLink = gmailMsg({ id: 's0', threadId: 'gt1', from: 'leo@example.com', to: 'tanaka@client.co.jp', labels: ['SENT'], body: '明日お送りします。https://example.com/about' });
  await ingest(fakeGmail({ s0: noLink }, { sent: ['s0'] }), ai);
  assert.ok(deadlines().every((d) => d.state === 'open'));
  const link = gmailMsg({ id: 's1', threadId: 'gt-new', from: 'leo@example.com', to: '田中 <tanaka@client.co.jp>', labels: ['SENT'], body: 'こちらです。\nhttps://example.com/client-preview/?feedback=1\nご確認ください。' });
  await ingest(fakeGmail({ s1: link }, { sent: ['s1'] }), ai);
  const [a, b, c] = deadlines();
  assert.equal(a.state, 'done'); assert.equal(a.done_reason, 'preview_sent');
  assert.equal(b.state, 'done', 'same company domain'); assert.equal(c.state, 'open', 'webmail domains never match by domain');
});

test('publish hook: admin token, client by slug/domain/address or threadId, reason published', async () => {
  await previewFromClient({ from: 'Kikuna Jam <hello@kikuna-jam.example>' });
  await previewFromClient({ id: 'r2', threadId: 'gt2', from: 'Ann <ann@gmail.com>' });
  const a = buildApp({ db, config, calendarClientFor: g.clientFor });
  const post = (payload, key = ADMIN) => a.inject({ method: 'POST', url: `/admin/businesses/${biz}/deadlines/close?key=${key}`, payload });
  assert.equal((await post({ client: 'kikuna' }, 'nope')).statusCode, 403);
  assert.equal((await post({})).statusCode, 400);
  assert.equal((await post({ client: 'x' })).statusCode, 400);
  assert.equal((await post({ client: 'kikuna', reason: 'whatever' })).statusCode, 400);
  const r = await post({ client: 'kikuna-preview', reason: 'published' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().closed.length, 1);
  const [k, ann] = deadlines();
  assert.equal(k.state, 'done'); assert.equal(k.done_reason, 'published');
  assert.equal(ann.state, 'open', 'gmail.com is never matched by slug or domain');
  assert.deepEqual(closeForClient(db, { businessId: biz, client: 'gmail.com' }), []);
  assert.equal((await post({ threadId: 'gt2' })).json().closed.length, 1);
  assert.equal((await post({ threadId: 'gt2' })).json().closed.length, 0, 'idempotent');
});

test('console: shadow shows deadlines only to owners; confirm puts it on the calendar and panel; 完了 closes it; manager board lists it', async () => {
  await previewFromClient();
  const d = deadlines()[0];
  const login = async (email) => {
    const idToken = `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
    const a = buildApp({ db, config, calendarClientFor: g.clientFor, exchange: async () => ({ id_token: idToken }), gmailFactory: () => ({ getThread: async () => ({ messages: [] }) }) });
    const start = await a.inject('/auth/login');
    const state = new URL(start.headers.location).searchParams.get('state');
    const cb = await a.inject(`/auth/google/callback?code=x&state=${state}`);
    const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
    return (method, url, payload) => a.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  };
  const own = await login('leo@example.com');
  const stf = await login('gus@example.com');
  const thread = (await own('GET', `/api/threads/${d.thread_id}`)).json();
  assert.equal(thread.deadline.id, d.id); assert.equal(thread.deadline.confirmed, false);
  assert.equal((await stf('GET', `/api/threads/${d.thread_id}`)).json().deadline, null, 'shadow: staff see nothing');
  assert.equal((await stf('POST', `/api/deadlines/${d.id}/confirm`, {})).statusCode, 404);

  const from = '2026-11-01T00:00:00Z'; const to = '2026-12-01T00:00:00Z';
  let cal = (await own('GET', `/api/calendar?from=${from}&to=${to}&view=team`)).json();
  assert.equal(cal.deadlines.length, 0, 'a suggestion is not on the calendar yet');
  const r = await own('POST', `/api/deadlines/${d.id}/confirm`, {});
  assert.equal(r.statusCode, 200, r.body);
  cal = (await own('GET', `/api/calendar?from=${from}&to=${to}&view=team`)).json();
  assert.equal(cal.deadlines.length, 1);
  const ev = cal.events.find((e) => e.kind === 'deadline');
  assert.ok(ev && ev.allDay); assert.equal(ev.start, '2026-11-08T15:00:00.000Z'); assert.equal(ev.end, '2026-11-09T15:00:00.000Z');
  assert.equal(ev.threadId, d.thread_id); assert.equal(ev.deadlineType, 'preview');

  const board = (await buildApp({ db, config, calendarClientFor: g.clientFor }).inject({ method: 'GET', url: '/api/manager/calendar?from=2026-11-01T00:00:00Z&to=2026-11-15T00:00:00Z', headers: { authorization: `Bearer ${ADMIN}` } })).json();
  assert.equal(board.deadlines.length, 1); assert.equal(board.deadlines[0].due, '2026-11-09'); assert.equal(board.deadlines[0].mailbox, 'leo@example.com');

  assert.equal((await own('POST', `/api/deadlines/${d.id}/done`, {})).json().deadline.doneReason, 'manual');
  cal = (await own('GET', `/api/calendar?from=${from}&to=${to}&view=team`)).json();
  assert.equal(cal.deadlines.length, 0); assert.ok(!cal.events.some((e) => e.kind === 'deadline'));
  assert.equal((await own('POST', `/api/deadlines/${d.id}/dismiss`, {})).statusCode, 409, 'a done deadline is not dismissed');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'deadline_done' AND target = ?").get(d.id));

  setMode('on');
  assert.notEqual((await stf('GET', `/api/calendar?from=${from}&to=${to}&view=team`)).statusCode, 404, 'on: staff see the tab');
});
