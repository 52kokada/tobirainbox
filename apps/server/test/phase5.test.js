import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { seedBusiness } from '../bin/seed.js';
import { notifyNew } from '../src/push.js';
import { draftForThread } from '../src/drafting.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 0.5, vapidPublicKey: 'BPUBLIC' };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;

let db; let biz; let mbx; let thr;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); mbx = newId(); thr = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Example Studio', 'active')").run(biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'leo@example.com', 'owner')").run(newId(), biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'staff@example.com', 'staff')").run(newId(), biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'shadow', 0)")
    .run(mbx, biz, encrypt('r', masterKey));
  seedBusiness(db, JSON.parse(readFileSync(new URL('../seeds/example.json', import.meta.url), 'utf8')));
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, 'G1', 'M1', 'inquiry', 'new', '森田 <info@sample-kitchen.jp>', 'ご相談', '2026-11-05T00:00:00Z')`).run(thr, biz, mbx);
});

async function as(email) {
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken(email) }) });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  const call = (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  return { app, cookie, call };
}

test('owner edits every setting; staff can read but not change', async () => {
  const o = await as('leo@example.com');
  const st = await as('staff@example.com');
  const read = (await st.call('GET', '/api/settings')).json();
  assert.equal(read.canEdit, false);
  assert.equal(read.voices.length, 7);
  assert.equal((await st.call('PUT', '/api/settings/business', { undoSeconds: 10 })).statusCode, 403);

  assert.equal((await o.call('PUT', '/api/settings/business', { undoSeconds: 31 })).statusCode, 400);
  assert.equal((await o.call('PUT', '/api/settings/business', { undoSeconds: 10, plainText: true, dailyCapUsd: 3 })).statusCode, 200);
  const b = db.prepare('SELECT undo_seconds, plain_text, ai_daily_cap_usd FROM businesses').get();
  assert.deepEqual(b, { undo_seconds: 10, plain_text: 1, ai_daily_cap_usd: 3 });

  // labels: hide a built-in, turn auto-draft on for a custom one; 要確認 cannot be hidden
  assert.equal((await o.call('PUT', '/api/settings/labels/unconfirmed', { hidden: true })).statusCode, 400);
  await o.call('PUT', '/api/settings/labels/sales_pitch', { hidden: true });
  await o.call('PUT', '/api/settings/labels/vip', { ja: '常連様', autoDraft: true });
  const labels = (await o.call('GET', '/api/settings')).json().labels;
  assert.equal(labels.find((l) => l.key === 'sales_pitch').hidden, true);
  assert.deepEqual(['vip', true], [labels.find((l) => l.key === 'vip').key, labels.find((l) => l.key === 'vip').autoDraft]);

  // playbook: add, edit, remove (kept as rejected)
  const { id } = (await o.call('POST', '/api/settings/playbook', { text: '予約は空き確認後に返信', label: 'booking' })).json();
  await o.call('PUT', `/api/settings/playbook/${id}`, { text: '予約は空き状況を確認してから返信する' });
  await o.call('DELETE', `/api/settings/playbook/${id}`);
  assert.equal(db.prepare('SELECT status FROM playbook_rules WHERE id = ?').get(id).status, 'rejected');

  // facts
  await o.call('PUT', '/api/settings/facts', { key: '営業時間', value: '10:00〜18:00' });
  assert.equal(db.prepare("SELECT value FROM facts WHERE key = '営業時間'").get().value, '10:00〜18:00');
  await o.call('DELETE', `/api/settings/facts?key=${encodeURIComponent('営業時間')}`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM facts WHERE key = '営業時間'").get().n, 0);

  // intake exclusions
  const r = (await o.call('POST', '/api/settings/intake', { kind: 'exclude_domain', value: 'News.Example.com' })).json();
  assert.equal(db.prepare('SELECT value FROM intake_rules WHERE id = ?').get(r.id).value, 'news.example.com');
  await o.call('DELETE', `/api/settings/intake/${r.id}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM intake_rules').get().n, 0);
});

test('shared voice: when chosen, every mailbox drafts in that voice', async () => {
  const o = await as('leo@example.com');
  const kit = db.prepare("SELECT id FROM voice_profiles WHERE mailbox_address = 'kit@example.com'").get().id;
  await o.call('PUT', '/api/settings/business', { sharedVoiceId: kit });
  let seen = '';
  const ai = { async complete(req) { seen = req.cacheable; return { text: '森田様\nお世話になっております。', model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0 }; } };
  const gmail = { getThread: async () => ({ messages: [] }) };
  const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mbx);
  await draftForThread({ db, mailbox, gmail, ai, threadId: thr, msg: { id: 'M1', body: '見てみたいです', from: 'info@sample-kitchen.jp' }, config });
  assert.match(seen, /write as Kit Y/);
});

test('team: owner invites and removes; removed member loses access; the last owner stays', async () => {
  const o = await as('leo@example.com');
  assert.equal((await o.call('POST', '/api/team', { email: 'Ada@example.com', role: 'staff' })).statusCode, 200);
  const ada = await as('ada@example.com');
  assert.equal((await ada.call('GET', '/api/me')).statusCode, 200);
  const adaId = db.prepare("SELECT id FROM users WHERE email = 'ada@example.com'").get().id;
  assert.equal((await o.call('DELETE', `/api/team/${adaId}`)).statusCode, 200);
  assert.equal((await ada.call('GET', '/api/me')).statusCode, 401, 'session ended');
  const me = db.prepare("SELECT id FROM users WHERE email = 'leo@example.com'").get().id;
  assert.equal((await o.call('DELETE', `/api/team/${me}`)).statusCode, 400);
});

test('push: a device subscribes; only new mail that needs a person is notified, once; dead subscriptions are dropped', async () => {
  const o = await as('leo@example.com');
  assert.equal((await o.call('GET', '/api/push/key')).json().key, 'BPUBLIC');
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };
  assert.equal((await o.call('POST', '/api/push/subscribe', { subscription: sub })).statusCode, 200);
  const sent = [];
  const send = async (s, payload) => { sent.push(JSON.parse(payload)); };
  assert.deepEqual(await notifyNew(db, { send }), { notified: 0, failed: 0 }, 'existing mail is not re-announced');

  db.prepare("UPDATE threads SET last_message_id = 'M2' WHERE id = ?").run(thr);
  const t2 = newId();
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, label_key, status, cache_from, cache_subject)
    VALUES (?, ?, ?, 'G2', 'N1', 'notice', 'new', 'News <n@x.jp>', 'お知らせ')`).run(t2, biz, mbx);
  const r = await notifyNew(db, { send });
  assert.equal(r.notified, 1);
  assert.match(sent[0].title, /新規問い合わせ｜森田/);
  assert.equal(sent[0].url, `/#t=${thr}`);
  assert.equal((await notifyNew(db, { send })).notified, 0, 'once only');

  db.prepare("UPDATE threads SET last_message_id = 'M3' WHERE id = ?").run(thr);
  await notifyNew(db, { send: async () => { const e = new Error('gone'); e.statusCode = 410; throw e; } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n, 0);
});

test('learnings: corrections are listed; owners can forget one, staff cannot', async () => {
  db.prepare("INSERT INTO label_corrections (business_id, thread_id, from_label, to_label, from_domain, subject_redacted) VALUES (?, ?, 'booking', 'question', 'hinata.jp', '撮影の件')").run(biz, thr);
  const o = await as('leo@example.com');
  const st = await as('staff@example.com');
  const s = (await st.call('GET', '/api/settings')).json();
  assert.equal(s.learnedCount, 1);
  assert.deepEqual([s.learnings[0].fromLabel, s.learnings[0].toLabel, s.learnings[0].domain], ['booking', 'question', 'hinata.jp']);
  assert.equal((await st.call('DELETE', `/api/settings/learnings/${s.learnings[0].id}`)).statusCode, 403);
  assert.equal((await o.call('DELETE', `/api/settings/learnings/${s.learnings[0].id}`)).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM label_corrections').get().n, 0);
  assert.equal((await o.call('DELETE', '/api/settings/learnings/999')).statusCode, 404);
});
