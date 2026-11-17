// Cold-outreach follow-ups from cockpit: sync matching/clearing, the two views, the follow-up draft guard, outcomes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { newId, Store } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { seedBusiness } from '../bin/seed.js';
import { applyFeed, syncOutreach, followupsUrl, COCKPIT_DRAFT_NOTE } from '../src/outreach.js';
import { flushOutbox } from '../src/cockpit-outbox.js';
import { FOLLOWUP_INSTRUCTION } from '../src/drafting.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 0.5 };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const gm = (id, from, body, labels = ['INBOX']) => ({
  id, threadId: 'G2', labelIds: labels, snippet: body, internalDate: '1793840000000',
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Re: ご提案' }], body: { data: b64(body) } },
});

let db; let biz; let other; let mbx; let mbx2;
const thread = (gid, from, { status = 'new', at = '2026-11-01T00:00:00Z', mailbox = mbx, business = biz } = {}) => {
  const id = newId();
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, ?, ?, 'inquiry', ?, ?, 'Re: ご提案', ?)`).run(id, business, mailbox, gid, `${gid}-m`, status, from, at);
  return id;
};
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); other = newId(); mbx = newId(); mbx2 = newId();
  db.prepare("INSERT INTO businesses (id, name, status, report_to_cockpit) VALUES (?, 'Example Studio', 'active', 1)").run(biz);
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Acme Shop', 'active')").run(other);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'leo@example.com', 'owner')").run(newId(), biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'live', 0)").run(mbx, biz, encrypt('r', masterKey));
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'sales@example.com', ?, 'connected', 'live', 0)").run(mbx2, biz, encrypt('r', masterKey));
  seedBusiness(db, JSON.parse(readFileSync(new URL('../seeds/example.json', import.meta.url), 'utf8')));
});
const lead = (o) => ({ lead_id: 'L1', company_name: '株式会社A', contact_email: 'a@a.co.jp', state: 'replied', bucket: 'unanswered_positive',
  positive_reply_at: '2026-11-05T00:00:00Z', last_activity_at: '2026-11-05T00:00:00Z', days_quiet: 0, our_last_sent_at: null, cockpit_draft: null, ...o });

test('feed URL comes from the events URL origin', () => {
  assert.equal(followupsUrl('https://cockpit.example.com/api/internal/brain/inbox-events'), 'https://cockpit.example.com/api/internal/brain/outreach-followups');
  assert.equal(followupsUrl(''), '');
});

test('sync stamps the latest matching thread in any mailbox, keeps unmatched leads, clears stale stamps', () => {
  const old = thread('G1', 'A <a@a.co.jp>', { at: '2026-10-01T00:00:00Z' });
  const latest = thread('G2', '担当 <A@A.co.jp>', { at: '2026-11-05T00:00:00Z', mailbox: mbx2 });
  const quiet = thread('G3', 'B <b@b.jp>', { status: 'sent' });
  thread('G4', 'C <c@c.jp>', { business: other, mailbox: mbx }); // another business's thread is never touched
  const r = applyFeed(db, biz, [lead(), lead({ lead_id: 'L2', contact_email: 'b@b.jp', bucket: 'gone_quiet', days_quiet: 9 }),
    lead({ lead_id: 'L3', contact_email: 'c@c.jp', company_name: '未接続', bucket: 'gone_quiet', days_quiet: 4, cockpit_draft: { subject: 's', body: 'b' } }),
    { lead_id: 'bad', contact_email: 'nope', bucket: 'unanswered_positive' }]);
  assert.deepEqual(r, { stamped: 2, cleared: 0, unmatched: 1, seeded: 0, needsDraft: [latest] });
  const row = (id) => db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  assert.equal(row(latest).cockpit_lead_id, 'L1');
  assert.equal(row(latest).outreach_bucket, 'unanswered_positive');
  assert.equal(row(old).outreach_bucket, null, 'only the latest thread of the address');
  assert.equal(row(quiet).outreach_days_quiet, 9);
  const u = db.prepare('SELECT * FROM outreach_leads').all();
  assert.equal(u.length, 1); assert.equal(u[0].company_name, '未接続'); assert.equal(u[0].draft_body, 'b');
  // Next feed: L1 is gone (we answered), L2 is unchanged, L3 is gone.
  const r2 = applyFeed(db, biz, [lead({ lead_id: 'L2', contact_email: 'b@b.jp', bucket: 'gone_quiet', days_quiet: 10 })]);
  assert.equal(r2.cleared, 1);
  assert.equal(row(latest).outreach_bucket, null);
  assert.equal(row(latest).cockpit_lead_id, 'L1', 'lead id kept so outcomes can still be recorded');
  assert.equal(row(quiet).outreach_days_quiet, 10);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM outreach_leads').get().n, 0);
});

test('a positive reply with no Inbox draft gets the Cockpit draft once; an existing draft is left alone', () => {
  const t1 = thread('G1', 'a@a.co.jp');
  const t2 = thread('G2', 'b@b.jp');
  new Store(db, biz).saveDraft({ threadId: t2, bodyText: '既存の下書き', createdBy: 'ai' });
  const feed = [lead({ cockpit_draft: { subject: 'Re', body: 'A様\n\nご返信ありがとうございます。' } }), lead({ lead_id: 'L2', contact_email: 'b@b.jp', cockpit_draft: { subject: 'Re', body: 'x' } })];
  assert.equal(applyFeed(db, biz, feed).seeded, 1);
  const d = db.prepare('SELECT * FROM drafts WHERE thread_id = ?').all(t1);
  assert.equal(d.length, 1); assert.equal(d[0].note, COCKPIT_DRAFT_NOTE); assert.equal(d[0].created_by, 'ai'); assert.equal(d[0].status, 'open');
  assert.equal(d[0].for_message_id, 'G1-m', 'counts as the draft for the latest message');
  db.prepare("UPDATE drafts SET status = 'discarded' WHERE thread_id = ?").run(t1);
  assert.equal(applyFeed(db, biz, feed).seeded, 0, 'a discarded Cockpit draft is not brought back');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sends').get().n, 0, 'nothing is queued to send');
});

test('syncOutreach: inert until configured; only businesses that report to cockpit; failures throw', async () => {
  assert.deepEqual(await syncOutreach(db, {}), { skipped: 'not configured' });
  const cfg = { cockpitEventsUrl: 'https://cockpit.example/api/internal/brain/inbox-events', cockpitEventsToken: 't' };
  thread('G1', 'a@a.co.jp');
  let seen;
  const r = await syncOutreach(db, cfg, { fetchImpl: async (url, o) => { seen = { url, auth: o.headers.authorization }; return { ok: true, json: async () => ({ generated_at: 'x', leads: [lead()] }) }; } });
  assert.equal(seen.url, 'https://cockpit.example/api/internal/brain/outreach-followups');
  assert.equal(seen.auth, 'Bearer t');
  assert.deepEqual(r.businesses.map((b) => b.id), [biz]);
  assert.equal(r.businesses[0].needsDraft, 1, 'no draft hook: counted, nothing drafted');
  // A positive reply with no Cockpit draft (retired lead) gets the normal AI draft through the hook, once.
  const t2 = thread('G7', 'n@n.jp');
  const asked = [];
  const feed = { leads: [lead({ lead_id: 'L9', contact_email: 'n@n.jp' })] };
  const tenantCfg = { ...cfg, cockpitTenant: 'tobira' };
  const r2 = await syncOutreach(db, tenantCfg, { fetchImpl: async (url) => { seen.url = url; return { ok: true, json: async () => feed }; },
    draftThread: async (id) => { asked.push(id); new Store(db, biz).saveDraft({ threadId: id, bodyText: 'AI', createdBy: 'ai' }); return { status: 'drafted' }; } });
  assert.equal(seen.url, 'https://cockpit.example/api/internal/brain/outreach-followups?tenant=tobira');
  assert.deepEqual(asked, [t2]); assert.equal(r2.businesses[0].drafted, 1);
  await syncOutreach(db, tenantCfg, { fetchImpl: async () => ({ ok: true, json: async () => feed }), draftThread: async (id) => { asked.push(id); return { status: 'drafted' }; } });
  assert.deepEqual(asked, [t2], 'an open draft is not drafted again');
  await assert.rejects(syncOutreach(db, cfg, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
});

async function as(email, { ai, gmailFactory } = {}) {
  const app = buildApp({ db, config, ai, gmailFactory, exchange: async () => ({ id_token: idToken(email) }) });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

test('views: 営業の返信 oldest positive reply first, フォローアップ most days quiet first, unmatched leads listed, a send takes it off', async () => {
  const a = thread('G1', 'a@a.co.jp'); const b = thread('G2', 'b@b.jp');
  const q1 = thread('G3', 'c@c.jp', { status: 'sent' }); const q2 = thread('G4', 'd@d.jp', { status: 'done' });
  thread('G5', 'e@e.jp'); // not a lead
  applyFeed(db, biz, [lead({ positive_reply_at: '2026-11-06T00:00:00Z' }), lead({ lead_id: 'L2', contact_email: 'b@b.jp', positive_reply_at: '2026-11-02T00:00:00Z' }),
    lead({ lead_id: 'L3', contact_email: 'c@c.jp', bucket: 'gone_quiet', days_quiet: 5 }), lead({ lead_id: 'L4', contact_email: 'd@d.jp', bucket: 'gone_quiet', days_quiet: 12 }),
    lead({ lead_id: 'L5', contact_email: 'x@x.jp', bucket: 'gone_quiet', days_quiet: 3, cockpit_draft: { subject: 's', body: 'b' } })]);
  const call = await as('leo@example.com');
  const o = (await call('GET', '/api/threads?view=outreach')).json();
  assert.deepEqual(o.threads.map((t) => t.id), [b, a]);
  assert.equal(o.threads[0].outreach.bucket, 'unanswered_positive');
  assert.equal(o.counts.outreach, 2); assert.equal(o.counts.followup, 3);
  assert.deepEqual(o.leads, []);
  const f = (await call('GET', '/api/threads?view=followup')).json();
  assert.deepEqual(f.threads.map((t) => t.id), [q2, q1]);
  assert.equal(f.threads[0].outreach.daysQuiet, 12);
  assert.equal(f.leads.length, 1); assert.equal(f.leads[0].email, 'x@x.jp'); assert.equal(f.leads[0].draft.body, 'b');
  // Queue a reply on b: it leaves 営業の返信 before the next sync.
  const store = new Store(db, biz);
  const d = store.saveDraft({ threadId: b, bodyText: 'ok', createdBy: 'user' });
  db.prepare("INSERT INTO sends (id, business_id, draft_id, user_id, idempotency_key, body_text, queued_at, undo_until) VALUES ('s1', ?, ?, (SELECT id FROM users LIMIT 1), 'k1', 'ok', ?, ?)")
    .run(biz, d, '2099-01-01T00:00:00Z', '2099-01-01T00:00:10Z');
  assert.deepEqual((await call('GET', '/api/threads?view=outreach')).json().threads.map((t) => t.id), [a]);
  // Another business sees no outreach tabs.
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'owner@sample-kitchen.jp', 'owner')").run(newId(), other);
  const c = (await (await as('owner@sample-kitchen.jp'))('GET', '/api/threads?view=todo')).json();
  assert.equal(c.counts.outreach, 0); assert.equal(c.counts.followup, 0);
});

test('follow-up draft: refused when the customer wrote last; drafted with the follow-up instruction when we did; never sent', async () => {
  const t = thread('G2', 'A <a@a.co.jp>', { status: 'sent' });
  let msgs = [gm('m1', 'Leo <leo@example.com>', 'ご提案です', ['SENT']), gm('m2', 'A <a@a.co.jp>', '興味があります')];
  const prompts = [];
  const ai = { async complete(req) { prompts.push(req); return { text: 'A様\n\n先日はご連絡ありがとうございました。', model: 'm', tokens_in: 1, tokens_out: 1, cost_usd: 0 }; } };
  const call = await as('leo@example.com', { ai, gmailFactory: () => ({ getThread: async () => ({ messages: msgs }) }) });
  const bad = await call('POST', `/api/threads/${t}/draft`, { mode: 'followup' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'they wrote last');
  msgs = [...msgs, gm('m3', 'Leo <leo@example.com>', 'サンプルをお送りしました', ['SENT'])];
  const ok = await call('POST', `/api/threads/${t}/draft`, { mode: 'followup' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(ok.json().draft.body, /先日は/);
  assert.ok(JSON.stringify(prompts.at(-1)).includes(FOLLOWUP_INSTRUCTION.slice(0, 60)), 'the follow-up instruction reaches the drafter');
  assert.equal(db.prepare("SELECT note FROM drafts WHERE thread_id = ? AND status = 'open'").get(t).note, 'フォローアップ');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sends').get().n, 0);
  // Without the mode, a thread where we wrote last still has an inbound message, so the normal route is unchanged.
});

test('outcome: only on outreach threads, valid values, stored and emitted through the outbox', async () => {
  const t = thread('G1', 'A <a@a.co.jp>');
  const plain = thread('G9', 'z@z.jp');
  applyFeed(db, biz, [lead()]);
  const call = await as('leo@example.com');
  assert.equal((await call('POST', `/api/threads/${plain}/outcome`, { outcome: 'won' })).statusCode, 409);
  assert.equal((await call('POST', `/api/threads/${t}/outcome`, { outcome: 'maybe' })).statusCode, 400);
  const r = await call('POST', `/api/threads/${t}/outcome`, { outcome: 'meeting_booked' });
  assert.equal(r.statusCode, 200);
  const ev = db.prepare("SELECT payload_json FROM outbox_events WHERE type = 'outcome'").all().map((x) => JSON.parse(x.payload_json));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'outcome');
  assert.equal(ev[0].lead_id, 'L1'); assert.equal(ev[0].contact_email, 'a@a.co.jp'); assert.equal(ev[0].gmail_thread_id, 'G1'); assert.equal(ev[0].outcome, 'meeting_booked');
  let body;
  await flushOutbox(db, { cockpitEventsUrl: 'https://c.example/api/internal/brain/inbox-events', cockpitEventsToken: 't' }, { fetchImpl: async (u, o) => { body = JSON.parse(o.body); return { ok: true }; } });
  assert.match(body.events.find((e) => e.type === 'outcome').eventId, /^tobira-inbox:[0-9]+$/, 'same envelope and eventId as every outbox event');
  const th = db.prepare('SELECT outreach_outcome FROM threads WHERE id = ?').get(t);
  assert.equal(th.outreach_outcome, 'meeting_booked');
});

test('a positive reply we already answered from Gmail is a follow-up after 5 quiet days, not 営業の返信', () => {
  const now = new Date('2026-11-09T00:00:00Z');
  const answered = thread('G5', 'D <d@d.jp>', { status: 'sent', at: '2026-11-01T00:00:00Z' });
  const recent = thread('G6', 'E <e@e.jp>', { status: 'done', at: '2026-11-07T00:00:00Z' });
  const waiting = thread('G7', 'F <f@f.jp>', { status: 'new', at: '2026-11-07T00:00:00Z' });
  const draft = { subject: 's', body: 'Cockpit の本文' };
  const r = applyFeed(db, biz, [
    lead({ lead_id: 'L5', contact_email: 'd@d.jp', cockpit_draft: draft }),
    lead({ lead_id: 'L6', contact_email: 'e@e.jp', cockpit_draft: draft }),
    lead({ lead_id: 'L7', contact_email: 'f@f.jp', cockpit_draft: draft }),
  ], { now });
  const row = (id) => db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  assert.equal(row(answered).outreach_bucket, 'gone_quiet');
  assert.equal(row(answered).outreach_days_quiet, 8);
  assert.equal(row(recent).outreach_bucket, null, 'answered 2 days ago: in neither list yet');
  assert.equal(row(recent).cockpit_lead_id, 'L6', 'outcome buttons still work');
  assert.equal(row(waiting).outreach_bucket, 'unanswered_positive');
  assert.equal(r.seeded, 1, 'only the thread still waiting on us gets the Cockpit draft');
});

test('a Cockpit draft seeded before we answered is discarded once we wrote last', () => {
  const t = thread('G8', 'G <g@g.jp>', { status: 'new' });
  const feed = [lead({ lead_id: 'L8', contact_email: 'g@g.jp', cockpit_draft: { subject: 's', body: 'b' } })];
  assert.equal(applyFeed(db, biz, feed).seeded, 1);
  db.prepare("UPDATE threads SET status = 'sent', last_message_at = '2026-11-01T00:00:00Z' WHERE id = ?").run(t);
  applyFeed(db, biz, feed, { now: new Date('2026-11-09T00:00:00Z') });
  assert.equal(db.prepare("SELECT count(*) n FROM drafts WHERE thread_id = ? AND status = 'open'").get(t).n, 0);
});
