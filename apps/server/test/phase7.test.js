// Second-release items: website facts (D8), learning (D4/D21/D22), owner questions (D23), sign-up (D20/D25).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId, Store } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { htmlToText, pickLinks, parseFacts, assertPublicUrl } from '../src/website.js';
import { saveExample, learnFromSent, importHistory, parseRules } from '../src/learning.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 5, adminToken: 'admintok' };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const b64 = (s) => Buffer.from(s).toString('base64url');
const gmsg = (id, from, body) => ({ id, threadId: 'T', internalDate: '1', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: 's' }], body: { data: b64(body) } } });

let db; let biz; let mbx; let thr; let pushed;
beforeEach(() => {
  db = openDb(':memory:'); pushed = [];
  biz = newId(); mbx = newId(); thr = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Example Studio', 'active')").run(biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'owner@example.com', 'owner')").run(newId(), biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'staff@example.com', 'staff')").run(newId(), biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'owner@example.com', ?, 'connected', 'live', 0)").run(mbx, biz, encrypt('r', masterKey));
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, label_key, status, cache_from, cache_subject)
    VALUES (?, ?, ?, 'G1', 'M1', 'inquiry', 'drafted', '佐藤 <sato@inn.example>', '英語ページ')`).run(thr, biz, mbx);
});

function appWith({ email = 'owner@example.com', ai = null, pages = {}, gm } = {}) {
  const websiteFetcher = async (url) => { if (!pages[url]) throw new Error('404'); return { url, html: pages[url] }; };
  return buildApp({ db, config, ai, websiteFetcher, gmailFactory: gm, pushSend: async (sub, payload) => pushed.push(JSON.parse(payload)), exchange: async () => ({ id_token: idToken(email) }) });
}
async function as(email, opts = {}) {
  const app = appWith({ email, ...opts });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return { app, call: (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) }) };
}

test('website: text, useful links and fact lines are parsed', () => {
  const html = '<html><head><title>宿 こもれび</title><script>x()</script></head><body><p>料金&nbsp;1泊 ¥12,000</p><a href="/price">料金</a><a href="/blog/1">日記</a><a href="https://other.example/x">x</a></body></html>';
  assert.match(htmlToText(html), /# 宿 こもれび[\s\S]*料金 1泊 ¥12,000/);
  assert.ok(!htmlToText(html).includes('x()'));
  assert.deepEqual(pickLinks(html, 'https://inn.example/'), ['https://inn.example/price']);
  assert.deepEqual(parseFacts('料金: 1泊 ¥12,000 | https://inn.example/price\nnot a fact\n- 定休日：水曜 | https://inn.example/'),
    [{ key: '料金', value: '1泊 ¥12,000', sourceUrl: 'https://inn.example/price' }, { key: '定休日', value: '水曜', sourceUrl: 'https://inn.example/' }]);
});

test('website: private and odd addresses are refused', async () => {
  for (const u of ['http://127.0.0.1/', 'http://10.0.0.5/x', 'http://[::1]/', 'file:///etc/passwd', 'http://192.168.1.1/', 'http://169.254.169.254/latest']) {
    await assert.rejects(assertPublicUrl(u), u);
  }
});

test('website read → proposals → owner accepts (edited) or rejects; staff cannot start a read', async () => {
  const ai = { complete: async (req) => { assert.equal(req.operation, 'website'); assert.match(req.prompt, /1泊 ¥12,000/); return { text: '料金: 1泊 ¥12,000 | https://inn.example/price\n営業時間: 9:00〜18:00 | https://inn.example/' }; } };
  const pages = { 'https://inn.example/': '<p>ようこそ。営業時間 9:00〜18:00</p><a href="/price">料金</a>', 'https://inn.example/price': '<p>料金 1泊 ¥12,000</p>' };
  const staff = await as('staff@example.com', { ai, pages });
  assert.equal((await staff.call('POST', '/api/website/read', { url: 'https://inn.example/' })).statusCode, 403);
  const o = await as('owner@example.com', { ai, pages });
  assert.equal((await o.call('POST', '/api/website/read?wait=1', { url: 'https://inn.example/' })).statusCode, 200);
  const l = (await o.call('GET', '/api/learn')).json();
  assert.equal(l.website.last.status, 'done');
  assert.equal(l.website.last.pages, 2);
  assert.equal(l.proposals.length, 2);
  const price = l.proposals.find((p) => p.key === '料金');
  await o.call('POST', `/api/facts/proposals/${price.id}`, { value: '1泊 ¥12,000（税込）' });
  await o.call('POST', `/api/facts/proposals/${l.proposals.find((p) => p.key === '営業時間').id}`, { action: 'reject' });
  assert.deepEqual(new Store(db, biz).facts().map((f) => [f.key, f.value, f.source]), [['料金', '1泊 ¥12,000（税込）', 'website']]);
  // a second read does not re-propose what was accepted or rejected
  await o.call('POST', '/api/website/read?wait=1', { url: 'https://inn.example/' });
  assert.equal((await o.call('GET', '/api/learn')).json().proposals.length, 0); // nothing the owner already decided comes back
});

test('learning: a sent reply becomes a redacted example; contact details never stored', () => {
  const ok = learnFromSent(db, {
    send: { body_text: '佐藤様\nありがとうございます。詳しくは 090-1234-5678 までお電話ください。' },
    thread: { label_key: 'inquiry' }, mailbox: { id: mbx, business_id: biz },
    delivered: { messageId: 'S1', incoming: '見てみたいです。sato@inn.example にご連絡ください。', incomingFrom: '佐藤 <sato@inn.example>' },
  });
  assert.equal(ok, true);
  const e = db.prepare('SELECT * FROM examples').get();
  assert.equal(e.label_key, 'inquiry'); assert.equal(e.source, 'sent');
  assert.ok(!e.incoming_redacted.includes('sato@')); assert.ok(!e.reply_redacted.includes('090'));
  // same Gmail message twice is kept once
  assert.equal(saveExample(db, { businessId: biz, incoming: '見てみたいです。', reply: 'ありがとうございます。', gmailMessageId: 'S1' }), false);
});

test('learning: history import pairs each of our replies with the message before it', async () => {
  const thread = { messages: [gmsg('a', 'Kei <kei@x.example>', '予約できますか？来週の土曜日です。'), gmsg('b', 'owner@example.com', 'ご連絡ありがとうございます。土曜日は空いております。'), gmsg('c', 'owner@example.com', '追伸です。当日は駐車場もご利用いただけます。')] };
  const gmail = { listSentThreads: async () => ['T1'], getThread: async () => thread };
  const r = await importHistory(db, { mailbox: { id: mbx, business_id: biz, address: 'owner@example.com' }, gmail });
  assert.equal(r.saved, 2); // both of our messages follow the customer's message
  assert.equal(db.prepare("SELECT COUNT(*) n FROM examples WHERE source = 'history'").get().n, 2);
  const again = await importHistory(db, { mailbox: { id: mbx, business_id: biz, address: 'owner@example.com' }, gmail });
  assert.equal(again.saved, 0);
});

test('learning: proposed rules arrive as proposals, never active', async () => {
  for (let i = 0; i < 4; i += 1) saveExample(db, { businessId: biz, labelKey: 'booking', incoming: `予約をお願いします ${i} 番`, reply: `空き状況を確認して折り返します ${i}`, gmailMessageId: `m${i}` });
  assert.deepEqual(parseRules('booking | 予約の問い合わせには、空き状況を確認してから折り返すと伝える。\n* | 返信は三行以内にまとめる。\nxx', ['booking']),
    [{ label: 'booking', text: '予約の問い合わせには、空き状況を確認してから折り返すと伝える。' }, { label: null, text: '返信は三行以内にまとめる。' }]);
  const ai = { complete: async (req) => { assert.equal(req.operation, 'rules'); assert.ok(!/@/.test(req.prompt.split('## Replies they sent')[1])); return { text: 'booking | 予約の問い合わせには、空き状況を確認してから折り返すと伝える。' }; } };
  const o = await as('owner@example.com', { ai });
  assert.deepEqual((await o.call('POST', '/api/learn/propose')).json(), { proposed: 1 });
  const rule = db.prepare('SELECT * FROM playbook_rules').get();
  assert.deepEqual([rule.status, rule.source, rule.label_key], ['proposed', 'ai_proposed', 'booking']);
  assert.equal(new Store(db, biz).playbook('booking').length, 0); // not used until accepted
});

test('owner question: ask about a blank → push to owners → answer fills the draft and saves a fact', async () => {
  new Store(db, biz).saveDraft({ threadId: thr, bodyText: '佐藤様\nお写真は【要確認：写真の枚数】ほどお送りください。', createdBy: 'ai' });
  const st = await as('staff@example.com');
  db.prepare("INSERT INTO push_subscriptions (id, business_id, user_id, endpoint, keys_json) VALUES ('p1', ?, (SELECT id FROM users WHERE role = 'owner'), 'https://push.example/1', '{}')").run(biz);
  assert.equal((await st.call('POST', `/api/threads/${thr}/ask`, { blank: 'ない' })).statusCode, 400);
  const { id } = (await st.call('POST', `/api/threads/${thr}/ask`, { blank: '写真の枚数' })).json();
  assert.equal(pushed.length, 1); assert.equal(pushed[0].url, `/#q=${id}`);
  assert.equal((await st.call('POST', `/api/threads/${thr}/ask`, { blank: '写真の枚数' })).json().again, true);
  const o = await as('owner@example.com');
  assert.equal((await o.call('GET', '/api/questions')).json().questions.length, 1);
  assert.deepEqual((await o.call('POST', `/api/questions/${id}/answer`, { answer: '10枚', factKey: '必要な写真の枚数' })).json(), { ok: true, filled: true });
  assert.equal(new Store(db, biz).latestDraft(thr).body_text, '佐藤様\nお写真は10枚ほどお送りください。');
  assert.equal(new Store(db, biz).facts().find((f) => f.key === '必要な写真の枚数').value, '10枚');
  assert.equal((await o.call('POST', `/api/questions/${id}/answer`, { answer: 'x' })).statusCode, 409);
});

test('sign-up: a one-time invite creates a company and owner, lands on the setup wizard', async () => {
  const app = appWith({ email: 'new@ryokan.example' });
  const inv = (await app.inject({ method: 'POST', url: '/admin/invites?key=admintok', payload: { note: '旅館みどり' } })).json();
  const start = await app.inject(`/signup?code=${inv.code}`);
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  assert.equal(cb.headers.location, '/#setup');
  const u = db.prepare("SELECT u.role, b.name FROM users u JOIN businesses b ON b.id = u.business_id WHERE u.email = 'new@ryokan.example'").get();
  assert.deepEqual(u, { role: 'owner', name: '旅館みどり' });
  assert.equal((await app.inject(`/signup?code=${inv.code}`)).statusCode, 400); // used up
  assert.equal((await app.inject({ method: 'POST', url: '/admin/invites?key=nope' })).statusCode, 403);
  // without an invite, an unknown account is still refused
  const app2 = appWith({ email: 'stranger@x.example' });
  const s2 = new URL((await app2.inject('/auth/login')).headers.location).searchParams.get('state');
  assert.equal((await app2.inject(`/auth/google/callback?code=x&state=${s2}`)).statusCode, 403);
});

test('a suggested rule can be talked through with the AI, then accepted with edits and a stage', async () => {
  const id = newId();
  db.prepare("INSERT INTO playbook_rules (id, business_id, text, source, status) VALUES (?, ?, '見積書を先に送る。', 'ai_proposed', 'proposed')").run(id, biz);
  let asked;
  const o = await as('owner@example.com', { ai: { complete: async (req) => { asked = req.prompt; return { text: '「見積書を PDF で先に送る。」' }; } } });
  const r = (await o.call('POST', `/api/settings/playbook/${id}/refine`, { instruction: 'PDF と書き足して' })).json();
  assert.equal(r.text, '見積書を PDF で先に送る。');
  assert.match(asked, /REQUEST: PDF と書き足して/);
  await o.call('PUT', `/api/settings/playbook/${id}`, { status: 'active', text: r.text, phase: 'deal' });
  const row = db.prepare('SELECT text, status, phase FROM playbook_rules WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { text: '見積書を PDF で先に送る。', status: 'active', phase: 'deal' });
});
