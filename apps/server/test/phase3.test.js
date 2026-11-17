import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { ingestMailbox } from '../src/ingest.js';
import { buildApp } from '../src/app.js';
import { seedBusiness } from '../bin/seed.js';
import { agreement } from '../bin/agreement.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, adminToken: 'tok-123', aiDailyCapUsd: 0.5 };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const msg = (id, { threadId = 'T1', from = '森田 <info@sample-kitchen.jp>', body = '見てみたいです。', labels = ['INBOX'] } = {}) => ({
  id, threadId, labelIds: labels, snippet: body, internalDate: '1793840000000',
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Re: ご提案' }], body: { data: b64(body) } },
});
function gmail(messages, threadMsgs) {
  return {
    profile: async () => ({ historyId: '1' }), listInbox: async () => Object.keys(messages),
    getMessage: async (id) => messages[id], labels: async () => [], createLabel: async (n) => ({ id: n, name: n }),
    modifyThread: async () => {}, getThread: async () => ({ messages: threadMsgs }),
  };
}
function ai(sortLabel, draftBody) {
  return {
    calls: [],
    async complete(req) {
      this.calls.push(req);
      if (req.operation === 'sort') return { text: `{"label":"${sortLabel}","confidence":0.9}`, model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0.0001 };
      return { text: draftBody, model: req.model, tokens_in: 1000, tokens_out: 400, cost_usd: 0.006 };
    },
  };
}

let db; let biz; let mbx;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); mbx = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Example Studio', 'active')").run(biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'shadow', 0)")
    .run(mbx, biz, encrypt('r', masterKey));
  seedBusiness(db, JSON.parse(readFileSync(new URL('../seeds/example.json', import.meta.url), 'utf8')));
});
const mailbox = () => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mbx);

test('seed: one voice per mailbox with the real signature, playbook and facts loaded', () => {
  const v = db.prepare('SELECT v.* FROM voice_profiles v JOIN mailboxes m ON m.voice_profile_id = v.id WHERE m.id = ?').get(mbx);
  assert.match(v.signature, /大野 晃/);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM playbook_rules').get().n >= 8);
  assert.match(db.prepare("SELECT value FROM facts WHERE key = '打ち合わせ予約（30分）'").get().value, /cal\.com/);
  seedBusiness(db, JSON.parse(readFileSync(new URL('../seeds/example.json', import.meta.url), 'utf8')));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM voice_profiles').get().n, 7, 're-seeding does not duplicate');
});

test('an auto-draft label gets one draft (with the thread as context), a notice does not, and nothing is sent', async () => {
  const msgs = { a: msg('a'), n: msg('n', { threadId: 'T2', labels: ['INBOX', 'CATEGORY_UPDATES'] }) };
  const sig = db.prepare('SELECT signature FROM voice_profiles WHERE mailbox_address = ?').get('leo@example.com').signature;
  const fake = ai('inquiry', `森田様\n\nお世話になっております。\n詳しくは https://cal.com/example/30min からどうぞ。料金は¥50,000です。\n\n${sig}`);
  const prior = msg('p', { from: 'Leo <leo@example.com>', body: 'サンプルをお作りします。' });
  const r = await ingestMailbox({ db, mailbox: mailbox(), ai: fake, config, gmailFactory: () => gmail(msgs, [prior, msgs.a]) });
  assert.equal(r.drafted, 1);
  const drafts = db.prepare('SELECT * FROM drafts').all();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].model, 'claude-sonnet-5-5');
  assert.match(drafts[0].body_text, /https:\/\/cal\.com\/example\/30min/, 'URL from facts kept');
  assert.match(drafts[0].body_text, /【要確認：金額】/, 'invented price becomes a blank');
  const draftCall = fake.calls.find((c) => c.operation === 'draft');
  assert.match(draftCall.variable, /WE SENT[\s\S]*サンプルをお作りします/);
  assert.match(draftCall.cacheable, /料金を本文に書かず/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sends').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM message_labels').get().n, 2);
});

test('drafting respects the daily cap', async () => {
  db.prepare("INSERT INTO ai_usage (business_id, operation, model, cost_usd) VALUES (?, 'draft', 'claude-sonnet-5-5', 0.6)").run(biz);
  const fake = ai('inquiry', 'x');
  const r = await ingestMailbox({ db, mailbox: mailbox(), ai: fake, config, gmailFactory: () => gmail({ a: msg('a') }, []) });
  assert.equal(r.drafted ?? 0, 0);
  assert.equal(fake.calls.length, 0);
});

test('admin review page needs the token, lists drafts and records ratings', async () => {
  const fake = ai('inquiry', '森田様\nお世話になっております。');
  await ingestMailbox({ db, mailbox: mailbox(), ai: fake, config, gmailFactory: () => gmail({ a: msg('a') }, []) });
  const app = buildApp({ db, config });
  assert.equal((await app.inject('/admin/drafts?key=nope')).statusCode, 403);
  const page = await app.inject('/admin/drafts?key=tok-123');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /下書きレビュー/);
  const id = db.prepare('SELECT id FROM drafts').get().id;
  const rate = await app.inject({ method: 'POST', url: `/admin/drafts/${id}/rate?key=tok-123`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'rating=1' });
  assert.equal(rate.statusCode, 302);
  assert.equal(db.prepare('SELECT rating FROM drafts').get().rating, 1);
});

test('agreement with cockpit: positive matches inquiry/question/booking, optout must match exactly', () => {
  const cockpit = new Database(':memory:');
  cockpit.exec('CREATE TABLE replies (id TEXT, gmail_message_id TEXT, verdict TEXT)');
  const ins = cockpit.prepare('INSERT INTO replies VALUES (?, ?, ?)');
  ins.run('1', 'm1', 'positive'); ins.run('2', 'm2', 'optout'); ins.run('3', 'm3', 'negative');
  const put = db.prepare("INSERT INTO message_labels (mailbox_id, gmail_message_id, gmail_thread_id, label_key, label_by) VALUES (?, ?, 't', ?, 'model')");
  put.run(mbx, 'm1', 'question'); put.run(mbx, 'm2', 'decline'); put.run(mbx, 'm3', 'decline'); put.run(mbx, 'm9', 'notice');
  const r = agreement(db, cockpit, 14);
  assert.equal(r.comparable, 3);
  assert.equal(r.agreed, 2);
  assert.deepEqual(r.mismatches.map((m) => m.id), ['m2']);
});

test('relabel: a person picks the label, the correction is saved without contact details, the sorter sees it next time', async () => {
  const fake = { calls: [], async complete(req) { this.calls.push(req); return { text: '{"label":"question","confidence":0.3}', model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0 }; } };
  await ingestMailbox({ db, mailbox: mailbox(), ai: fake, config: { ...config, drafting: false }, gmailFactory: () => gmail({ a: msg('a', { body: '森田様 info@sample-kitchen.jp 090-1234-5678 予約したいです' }) }, []) });
  const t = db.prepare('SELECT * FROM threads').get();
  assert.equal(t.label_key, 'unconfirmed');
  assert.equal(t.label_guess, 'question');
  const app = buildApp({ db, config });
  assert.match((await app.inject('/admin/sort?key=tok-123')).body, /要確認（AI の推測: question 30%）/);
  const r = await app.inject({ method: 'POST', url: `/admin/threads/${t.id}/label?key=tok-123`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'label=booking' });
  assert.equal(r.statusCode, 302);
  assert.deepEqual(db.prepare('SELECT label_key, label_by FROM threads').get(), { label_key: 'booking', label_by: 'person' });
  const c = db.prepare('SELECT * FROM label_corrections').get();
  assert.equal(c.to_label, 'booking');
  assert.equal(c.from_domain, 'sample-kitchen.jp');
  assert.ok(!c.excerpt_redacted.includes('@') && !c.excerpt_redacted.includes('090'));
  await ingestMailbox({ db, mailbox: mailbox(), ai: fake, config: { ...config, drafting: false }, gmailFactory: () => ({ ...gmail({ b: msg('b', { threadId: 'T9' }) }, []), historySince: async () => ({ messageIds: ['b'], historyId: '2' }) }) });
  assert.match(fake.calls.at(-1).prompt, /Past decisions by this business[\s\S]*→ booking/);
});

test('spend tracking: every billed call is recorded centrally (refusals too), with mailbox, thread and cache tokens', async () => {
  const { createAi } = await import('../src/ai.js');
  const reply = (extra = {}) => ({ id: 'msg_1', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000 }, ...extra });
  let refuse = false;
  const client = { beta: { messages: { create: async () => (refuse ? reply({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }) : reply()) } }, messages: { create: async () => reply() } };
  const real = createAi({ client, db });
  const meter = { businessId: biz, mailboxId: mbx, threadId: 'th1' };
  const r = await real.complete({ operation: 'draft', prompt: 'x', model: 'claude-sonnet-5-5', meter });
  assert.equal(r.metered, true);
  refuse = true;
  await assert.rejects(real.complete({ operation: 'draft', prompt: 'x', model: 'claude-sonnet-5-5', meter }), /refused/);
  const rows = db.prepare('SELECT * FROM ai_usage ORDER BY id').all();
  assert.deepEqual(rows.map((x) => x.outcome), ['ok', 'refused']);
  assert.equal(rows[0].cache_read_tokens, 4000);
  assert.equal(rows[0].request_id, 'msg_1');
  assert.equal(rows[0].mailbox_id, mbx);
  assert.ok(Math.abs(rows[0].cost_usd - (1000 * 2 + 4000 * 0.2 + 500 * 10) / 1e6) < 1e-12);
  const app = buildApp({ db, config });
  const j = (await app.inject('/admin/usage?key=tok-123&format=json')).json();
  assert.equal(j.companies[0].spend.today.rows.length, 1);
  assert.equal(j.companies[0].byMailbox[0].mailbox, 'leo@example.com');
  assert.equal((await app.inject('/admin/usage?key=tok-123')).statusCode, 200);
});

test('failed drafts are retried until clean, with back-off', async () => {
  let fail = true;
  const fake = {
    async complete(req) {
      if (req.operation === 'sort') return { text: '{"label":"inquiry","confidence":0.9}', model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0 };
      if (fail) throw new Error('overloaded');
      return { text: '森田様\nお世話になっております。', model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0 };
    },
  };
  const g = gmail({ a: msg('a') }, []);
  await ingestMailbox({ db, mailbox: mailbox(), ai: fake, config, gmailFactory: () => g });
  let a = db.prepare('SELECT * FROM draft_attempts').get();
  assert.equal(a.status, 'pending');
  assert.equal(a.attempts, 1);
  const { retryPendingDrafts } = await import('../src/drafting.js');
  assert.equal((await retryPendingDrafts({ db, mailbox: mailbox(), gmail: g, ai: fake, config })).retried, 0, 'back-off not over yet');
  fail = false;
  const rr = await retryPendingDrafts({ db, mailbox: mailbox(), gmail: g, ai: fake, config, now: new Date(Date.now() + 10 * 60_000) });
  assert.equal(rr.drafted, 1);
  a = db.prepare('SELECT * FROM draft_attempts').get();
  assert.equal(a.status, 'drafted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM drafts').get().n, 1);
});

test('the daily cap is a per-company setting that overrides the server default', async () => {
  const { underDailyCap } = await import('../src/ingest-cap.js');
  db.prepare("INSERT INTO ai_usage (business_id, operation, model, cost_usd) VALUES (?, 'draft', 'claude-sonnet-5-5', 0.6)").run(biz);
  assert.equal(underDailyCap(db, biz, 0.5), false);
  db.prepare('UPDATE businesses SET ai_daily_cap_usd = 20 WHERE id = ?').run(biz);
  assert.equal(underDailyCap(db, biz, 0.5), true);
});
