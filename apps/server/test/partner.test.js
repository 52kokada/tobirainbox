// D8 partner role: limited access the shop agrees to. A partner sees only granted mailboxes,
// sends only where allowed, and never sees settings, playbook, facts, team or alerts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId, Store } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { queueSend, SendRefused } from '../src/send-queue.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 0.5, vapidPublicKey: 'BPUBLIC' };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;

let db; let biz; let mA; let mB; let tA; let tB; let partnerId; let draftA;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); mA = newId(); mB = newId(); tA = newId(); tB = newId(); partnerId = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Shop', 'active')").run(biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'owner@shop.jp', 'owner')").run(newId(), biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'p@partner.jp', 'partner')").run(partnerId, biz);
  for (const [id, addr] of [[mA, 'info@shop.jp'], [mB, 'boss@shop.jp']]) {
    db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, ?, ?, 'connected', 'live', 0)")
      .run(id, biz, addr, encrypt('r', masterKey));
  }
  for (const [id, mb, g] of [[tA, mA, 'GA'], [tB, mB, 'GB']]) {
    db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, label_key, status, cache_from, cache_subject, last_message_at)
      VALUES (?, ?, ?, ?, 'M', 'inquiry', 'new', '客 <c@x.jp>', 'ご相談', '2026-11-05T00:00:00Z')`).run(id, biz, mb, g);
  }
  draftA = new Store(db, biz).saveDraft({ threadId: tA, bodyText: 'お世話になっております。', createdBy: 'ai' });
});

async function as(email) {
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken(email) }) });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

test('a partner with no grants sees nothing, and no company settings', async () => {
  const call = await as('p@partner.jp');
  const list = (await call('GET', '/api/threads?view=all')).json();
  assert.equal(list.threads.length, 0);
  assert.equal(list.counts.all, 0);
  assert.equal((await call('GET', '/api/me')).json().mailboxes.length, 0);
  assert.equal((await call('GET', `/api/threads/${tA}/versions`)).statusCode, 404);
  assert.equal((await call('GET', '/api/settings')).statusCode, 403);
  assert.equal((await call('GET', '/api/learn')).statusCode, 403);
  assert.equal((await call('GET', '/api/questions')).statusCode, 403);
  assert.deepEqual((await call('GET', '/api/alerts')).json().alerts, []);
});

test('owner grants one mailbox see-only: partner sees just that one and cannot send, until send is allowed', async () => {
  const owner = await as('owner@shop.jp');
  const r = await owner('PUT', `/api/team/${partnerId}/access`, { access: [{ mailboxId: mA, canSend: false }, { mailboxId: 'not-ours', canSend: true }] });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().access, [{ mailboxId: mA, canSend: false }]);
  const row = (await owner('GET', '/api/settings')).json().team.find((u) => u.id === partnerId);
  assert.deepEqual(row.access, [{ mailboxId: mA, canSend: false }]);

  const call = await as('p@partner.jp');
  const list = (await call('GET', '/api/threads?view=all')).json();
  assert.deepEqual(list.threads.map((t) => t.id), [tA]);
  assert.equal((await call('POST', `/api/threads/${tB}/claim`, {})).statusCode, 404);
  assert.equal((await call('POST', `/api/threads/${tB}/status`, { status: 'done' })).statusCode, 404);
  assert.equal(db.prepare('SELECT status FROM threads WHERE id = ?').get(tB).status, 'new');
  assert.equal((await call('POST', `/api/threads/${tA}/claim`, {})).statusCode, 200);

  const refused = await call('POST', `/api/threads/${tA}/send`, { draftId: draftA });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error, 'partner_cannot_send');
  assert.throws(() => queueSend(new Store(db, biz), { userId: partnerId, draftId: draftA }),
    (e) => e instanceof SendRefused && e.code === 'partner_cannot_send');

  await owner('PUT', `/api/team/${partnerId}/access`, { access: [{ mailboxId: mA, canSend: true }] });
  const ok = await call('POST', `/api/threads/${tA}/send`, { draftId: draftA });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('a partner cannot reach another mailbox draft by its id; staff are unaffected', async () => {
  const draftB = new Store(db, biz).saveDraft({ threadId: tB, bodyText: 'x', createdBy: 'ai' });
  const call = await as('p@partner.jp');
  assert.equal((await call('PUT', `/api/drafts/${draftB}`, { body: 'changed' })).statusCode, 404);
  const staffId = newId();
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 's@shop.jp', 'staff')").run(staffId, biz);
  const staff = await as('s@shop.jp');
  assert.equal((await staff('GET', '/api/threads?view=all')).json().threads.length, 2);
  const owner = await as('owner@shop.jp');
  assert.equal((await owner('PUT', `/api/team/${staffId}/access`, { access: [] })).statusCode, 400);
});

test('inviting a partner sets grants; removing them drops the grants', async () => {
  const owner = await as('owner@shop.jp');
  await owner('POST', '/api/team', { email: 'new@partner.jp', role: 'partner', access: [{ mailboxId: mB, canSend: true }] });
  const u = db.prepare("SELECT id FROM users WHERE email = 'new@partner.jp'").get();
  assert.equal(db.prepare('SELECT can_send FROM partner_mailboxes WHERE user_id = ?').get(u.id).can_send, 1);
  await owner('DELETE', `/api/team/${u.id}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM partner_mailboxes WHERE user_id = ?').get(u.id).n, 0);
  const team = (await owner('GET', '/api/settings')).json().team.map((x) => x.email);
  assert.ok(!team.some((e) => e.startsWith('new@partner.jp')), `removed member still listed: ${team}`);
});
