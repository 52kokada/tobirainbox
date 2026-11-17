import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { createAi, costUsd } from '../src/ai.js';
import { intakeDecision, ingestMailbox, ingestAll } from '../src/ingest.js';
import { parseMessage, GmailError } from '../src/gmail.js';
import { authUrl, emailFromIdToken } from '../src/google.js';
import { buildApp } from '../src/app.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'cid', clientSecret: 'sec', masterKey, adminToken: 'admin-token-123', publicUrl: 'https://inbox.example.com' };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

function gmailMsg({ id, threadId = `t-${id}`, from = '森田 <info@sample-kitchen.jp>', subject = 'ご予約', body = '11/20に2名で予約できますか', labels = ['INBOX'], extraHeaders = [] }) {
  return {
    id, threadId, labelIds: labels, snippet: body.slice(0, 50), internalDate: '1793840000000',
    payload: { mimeType: 'multipart/alternative', headers: [
      { name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@x>` }, ...extraHeaders,
    ], parts: [{ mimeType: 'text/plain', body: { data: b64(body) } }, { mimeType: 'text/html', body: { data: b64(`<p>${body}</p>`) } }] },
  };
}

function fakeGmail(messages, { historyId = '500', history = null, historyThrows = null } = {}) {
  const calls = { modify: [], created: [], get: [] };
  const labels = [];
  return {
    calls,
    profile: async () => ({ historyId }),
    listInbox: async () => Object.keys(messages),
    historySince: async () => { if (historyThrows) throw historyThrows; return history; },
    getMessage: async (id) => { calls.get.push(id); return messages[id]; },
    labels: async () => labels,
    createLabel: async (name) => { const l = { id: `L${labels.length}`, name }; labels.push(l); calls.created.push(name); return l; },
    modifyThread: async (threadId, change) => { calls.modify.push({ threadId, ...change }); },
  };
}

const fakeAi = (label = 'booking') => ({ n: 0, async complete() { this.n += 1; return { text: `{"label":"${label}","confidence":0.9}`, model: 'claude-haiku-5-5', tokens_in: 100, tokens_out: 10, cost_usd: 0.00002 }; } });

let db; let biz; let mbx;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); mbx = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Tobira', 'active')").run(biz);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode) VALUES (?, ?, 'leo@example.com', ?, 'connected', 'shadow')")
    .run(mbx, biz, encrypt('refresh-1', masterKey));
});
const mailbox = () => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mbx);

test('crypto round-trips and refuses a bad key', () => {
  const blob = encrypt('secret refresh token', masterKey);
  assert.ok(!blob.includes('secret'));
  assert.equal(decrypt(blob, masterKey), 'secret refresh token');
  assert.throws(() => decrypt(blob, randomBytes(32).toString('base64')));
  assert.throws(() => encrypt('x', 'short'), /32 bytes/);
});

test('cost: Haiku sort and Sonnet draft priced per 1M tokens incl. cache', () => {
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 0.6);
  assert.equal(costUsd('claude-sonnet-5-5', { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 }), 0.2);
  assert.equal(costUsd('unknown', { input_tokens: 5 }), 0);
});

test('ai.complete: cached system block for drafts, fallback beta for Sonnet, plain call + low effort for Haiku, refusal throws', async () => {
  const seen = [];
  const reply = (extra = {}) => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 }, ...extra });
  const client = {
    messages: { create: async (p) => { seen.push(['plain', p]); return reply(); } },
    beta: { messages: { create: async (p) => { seen.push(['beta', p]); return reply(); } } },
  };
  const ai = createAi({ client });
  await ai.complete({ operation: 'draft', cacheable: 'STABLE', variable: 'VAR', model: 'claude-sonnet-5-5' });
  await ai.complete({ operation: 'sort', prompt: 'P', model: 'claude-haiku-5-5', maxTokens: 40 });
  assert.equal(seen[0][0], 'beta');
  assert.deepEqual(seen[0][1].system, [{ type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } }]);
  assert.equal(seen[0][1].fallbacks, 'default');
  assert.equal(seen[1][0], 'plain');
  assert.deepEqual(seen[1][1].output_config, { effort: 'low' });
  const refusing = createAi({ client: { messages: { create: async () => reply({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }) } } });
  await assert.rejects(refusing.complete({ operation: 'sort', prompt: 'x', model: 'claude-haiku-5-5' }), /refused/);
});

test('parseMessage reads headers and prefers text/plain', () => {
  const m = parseMessage(gmailMsg({ id: 'm1', extraHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }));
  assert.equal(m.subject, 'ご予約');
  assert.equal(m.body, '11/20に2名で予約できますか');
  assert.equal(m.autoSubmitted, 'auto-replied');
  assert.equal(m.messageId, '<m1@x>');
});

test('intake: everything in by default; exclusions by sender, domain, label; include-only', () => {
  const msg = { from: 'News <news@mail.shop.jp>', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] };
  assert.equal(intakeDecision(msg, []), 'in');
  assert.equal(intakeDecision(msg, [{ kind: 'exclude_domain', value: 'shop.jp' }]), 'excluded');
  assert.equal(intakeDecision(msg, [{ kind: 'exclude_sender', value: 'news@mail.shop.jp' }]), 'excluded');
  assert.equal(intakeDecision(msg, [{ kind: 'exclude_gmail_label', value: 'CATEGORY_PROMOTIONS' }]), 'excluded');
  assert.equal(intakeDecision(msg, [{ kind: 'include_only_gmail_label', value: 'Cockpit' }]), 'excluded');
});

test('first poll seeds from the inbox, sorts, labels in Gmail, skips own mail; second poll pays nothing for the same mail', async () => {
  const msgs = {
    a: gmailMsg({ id: 'a' }),
    b: gmailMsg({ id: 'b', from: 'Leo <leo@example.com>', labels: ['INBOX', 'SENT'] }),
    c: gmailMsg({ id: 'c', from: 'x <bot@x.jp>', subject: 'Automatic reply: 不在', extraHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }),
  };
  const g = fakeGmail(msgs);
  const ai = fakeAi('booking');
  const r = await ingestMailbox({ db, mailbox: mailbox(), ai, config, gmailFactory: () => g });
  assert.deepEqual({ sorted: r.sorted, own: r.own, errors: r.errors }, { sorted: 2, own: 1, errors: 0 });
  assert.equal(ai.n, 1, 'auto-reply sorted by rule, no model call');
  const threads = db.prepare('SELECT gmail_thread_id, label_key, label_by, status FROM threads ORDER BY gmail_thread_id').all();
  assert.deepEqual(threads.map((t) => [t.gmail_thread_id, t.label_key, t.label_by]), [['t-a', 'booking', 'model'], ['t-c', 'auto_reply', 'rule']]);
  assert.ok(g.calls.created.includes('TobirAInbox/予約'));
  assert.equal(g.calls.modify.length, 2);
  assert.equal(mailbox().history_id, '500');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage').get().n, 1);

  const g2 = fakeGmail(msgs, { history: { messageIds: ['a', 'b', 'c'], historyId: '600' } });
  const r2 = await ingestMailbox({ db, mailbox: mailbox(), ai, config, gmailFactory: () => g2 });
  assert.equal(r2.checked, 0);
  assert.equal(ai.n, 1);
  assert.equal(mailbox().history_id, '600');
});

test('expired history id resyncs from the inbox instead of failing', async () => {
  db.prepare("UPDATE mailboxes SET history_id = '1' WHERE id = ?").run(mbx);
  const g = fakeGmail({ a: gmailMsg({ id: 'a' }) }, { historyId: '900', historyThrows: new GmailError(404, {}) });
  const r = await ingestMailbox({ db, mailbox: mailbox(), ai: fakeAi(), config, gmailFactory: () => g });
  assert.equal(r.sorted, 1);
  assert.equal(mailbox().history_id, '900');
});

test('a reply on a handled thread reopens it; labels off means Gmail is untouched', async () => {
  db.prepare('UPDATE mailboxes SET write_labels = 0 WHERE id = ?').run(mbx);
  const g = fakeGmail({ a: gmailMsg({ id: 'a', threadId: 'T' }) });
  await ingestMailbox({ db, mailbox: mailbox(), ai: fakeAi(), config, gmailFactory: () => g });
  db.prepare("UPDATE threads SET status = 'done'").run();
  const g2 = fakeGmail({ a2: gmailMsg({ id: 'a2', threadId: 'T' }) }, { history: { messageIds: ['a2'], historyId: '700' } });
  await ingestMailbox({ db, mailbox: mailbox(), ai: fakeAi('question'), config, gmailFactory: () => g2 });
  const t = db.prepare('SELECT status, label_key FROM threads').get();
  assert.deepEqual(t, { status: 'new', label_key: 'question' });
  assert.equal(g.calls.modify.length + g2.calls.modify.length, 0);
});

test('one mailbox failing does not stop the others; revoked access marks it error', async () => {
  const mbx2 = newId();
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status) VALUES (?, ?, 'hal@example.com', ?, 'connected')")
    .run(mbx2, biz, encrypt('refresh-2', masterKey));
  const good = fakeGmail({ a: gmailMsg({ id: 'a' }) });
  const bad = { ...fakeGmail({}), profile: async () => { throw new GmailError(401, { error: { message: 'invalid_grant' } }); } };
  const out = await ingestAll({ db, ai: fakeAi(), config, log: {}, gmailFactory: ({ refreshToken }) => (refreshToken === 'refresh-2' ? bad : good) });
  assert.equal(out.length, 2);
  assert.equal(db.prepare('SELECT status FROM mailboxes WHERE id = ?').get(mbx2).status, 'error');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM threads').get().n, 1);
});

test('google helpers: auth URL asks for offline Gmail access; id_token email read', () => {
  const u = new URL(authUrl({ clientId: 'cid', redirectUri: 'https://inbox.example.com/auth/google/callback', state: 's', loginHint: 'leo@example.com' }));
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.ok(u.searchParams.get('scope').includes('gmail.modify'));
  const idt = `x.${Buffer.from(JSON.stringify({ email: 'Leo@example.com', email_verified: true })).toString('base64url')}.y`;
  assert.equal(emailFromIdToken(idt), 'leo@example.com');
});

test('connect flow: admin key required, state single-use, mailbox stored encrypted in shadow mode', async () => {
  const idt = `x.${Buffer.from(JSON.stringify({ email: 'kit@example.com', email_verified: true })).toString('base64url')}.y`;
  const app = buildApp({ db, config, exchange: async () => ({ refresh_token: 'refresh-k', id_token: idt }) });
  assert.equal((await app.inject(`/connect/google?business=${biz}&key=wrong`)).statusCode, 403);
  const start = await app.inject(`/connect/google?business=${biz}&key=${config.adminToken}`);
  assert.equal(start.statusCode, 302);
  const state = new URL(start.headers.location).searchParams.get('state');
  const done = await app.inject(`/auth/google/callback?code=abc&state=${state}`);
  assert.equal(done.statusCode, 200);
  assert.match(done.body, /kit@example\.com/);
  const row = db.prepare("SELECT * FROM mailboxes WHERE address = 'kit@example.com'").get();
  assert.equal(row.mode, 'shadow');
  assert.equal(decrypt(row.token_enc, masterKey), 'refresh-k');
  assert.equal((await app.inject(`/auth/google/callback?code=abc&state=${state}`)).statusCode, 400);
});

test('Gmail tabs and spam are sorted without the model; daily cap stops model calls', async () => {
  const msgs = {
    p: gmailMsg({ id: 'p', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
    u: gmailMsg({ id: 'u', labels: ['INBOX', 'CATEGORY_UPDATES'] }),
    q: gmailMsg({ id: 'q' }),
  };
  const ai = fakeAi('question');
  await ingestMailbox({ db, mailbox: mailbox(), ai, config: { ...config, aiDailyCapUsd: 0.5 }, gmailFactory: () => fakeGmail(msgs) });
  assert.equal(ai.n, 1, 'only the Primary-tab message reaches the model');
  const by = Object.fromEntries(db.prepare('SELECT gmail_thread_id, label_by FROM threads').all().map((r) => [r.gmail_thread_id, r.label_by]));
  assert.deepEqual(by, { 't-p': 'gmail', 't-u': 'gmail', 't-q': 'model' });

  db.prepare("INSERT INTO ai_usage (business_id, operation, model, cost_usd) VALUES (?, 'sort', 'claude-haiku-5-5', 0.6)").run(biz);
  const ai2 = fakeAi('question');
  const g2 = fakeGmail({ r: gmailMsg({ id: 'r' }) }, { history: { messageIds: ['r'], historyId: '800' } });
  await ingestMailbox({ db, mailbox: mailbox(), ai: ai2, config: { ...config, aiDailyCapUsd: 0.5 }, gmailFactory: () => g2 });
  assert.equal(ai2.n, 0);
  assert.equal(db.prepare("SELECT label_by FROM threads WHERE gmail_thread_id = 't-r'").get().label_by, 'budget');
});

test('spam watch: a customer Gmail filed as spam comes out (marked), newsletters and sales pitches stay in spam', async () => {
  const msgs = {
    cust: gmailMsg({ id: 'cust', labels: ['SPAM'], from: 'Guest <guest@hotel.jp>', subject: 'ご予約', body: '来週2名で予約できますか' }),
    news: gmailMsg({ id: 'news', labels: ['SPAM'], from: 'Shop <news@shop.example>', extraHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:u@shop.example>' }] }),
    pitch: gmailMsg({ id: 'pitch', labels: ['SPAM'], from: 'SEO <seo@agency.example>', subject: 'SEOのご提案' }),
  };
  const g = { ...fakeGmail({}, { history: { messageIds: [], historyId: '501' } }), getMessage: async (id) => msgs[id], listSpam: async () => Object.keys(msgs) };
  db.prepare("UPDATE mailboxes SET history_id = '500' WHERE id = ?").run(mbx);
  let n = 0;
  const ai = { async complete(req) { n += 1; const label = /SEO/.test(req.prompt) ? 'sales_pitch' : 'booking'; return { text: `{"label":"${label}","confidence":0.9}`, model: 'claude-haiku-5-5', tokens_in: 1, tokens_out: 1, cost_usd: 0 }; } };
  await ingestMailbox({ db, mailbox: mailbox(), ai, config: { ...config, drafting: false }, gmailFactory: () => g });
  const rows = db.prepare('SELECT gmail_thread_id g, label_key, in_spam, status FROM threads').all();
  assert.deepEqual(rows.map((r) => [r.g, r.label_key, r.in_spam, r.status]), [['t-cust', 'booking', 1, 'new']]);
  assert.equal(n, 2, 'the newsletter never reached the model');
  // checked at most every 10 minutes
  await ingestMailbox({ db, mailbox: mailbox(), ai, config: { ...config, drafting: false }, gmailFactory: () => ({ ...g, listSpam: async () => { throw new Error('should not be called'); } }) });
});

test('alerts: a mailbox losing access raises one alert (no repeats), and it closes when the mailbox works again', async () => {
  const { openAlerts } = await import('../src/alerts.js');
  const denied = () => ({ profile: async () => { throw new GmailError(401, 'invalid_grant'); }, listInbox: async () => [] });
  await ingestAll({ db, ai: fakeAi(), config: { ...config, drafting: false }, gmailFactory: denied, log: {} });
  db.prepare("UPDATE mailboxes SET status = 'connected' WHERE id = ?").run(mbx);
  await ingestAll({ db, ai: fakeAi(), config: { ...config, drafting: false }, gmailFactory: denied, log: {} });
  const open = openAlerts(db, biz);
  assert.equal(open.length, 1);
  assert.match(open[0].title, /leo@example\.com の接続が切れました/);
  db.prepare("UPDATE mailboxes SET status = 'connected' WHERE id = ?").run(mbx);
  await ingestAll({ db, ai: fakeAi(), config: { ...config, drafting: false }, gmailFactory: () => fakeGmail({}), log: {} });
  assert.equal(openAlerts(db, biz).length, 0);
});

test('answered elsewhere: when a teammate (unconnected mailbox, same domain) replied last, the thread closes and gets no draft', async () => {
  const { lastWord, closeIfAnswered } = await import('../src/answered.js');
  const cust = gmailMsg({ id: 'c1', threadId: 'TH', from: '名古屋 <info@waterlab.example>', subject: 'デモ' });
  const hal = gmailMsg({ id: 'h1', threadId: 'TH', from: 'Hal Hayashi <hal@example.com>', subject: 'Re: デモ', labels: ['INBOX'] });
  assert.equal(lastWord(db, biz, [cust]).ours, false);
  assert.equal(lastWord(db, biz, [cust, hal]).ours, true);
  const tid = newId();
  db.prepare("INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from) VALUES (?, ?, ?, 'TH', 'inquiry', 'drafted', 'x')").run(tid, biz, mbx);
  // the sweep (every 10 min) closes it
  db.prepare("UPDATE mailboxes SET history_id = '500', spam_checked_at = NULL WHERE id = ?").run(mbx);
  const g = { ...fakeGmail({}, { history: { messageIds: [], historyId: '501' } }), listSpam: async () => [], getThread: async () => ({ messages: [cust, hal] }) };
  const r = await ingestMailbox({ db, mailbox: mailbox(), ai: fakeAi(), config: { ...config, drafting: false }, gmailFactory: () => g });
  assert.equal(r.answeredElsewhere, 1);
  assert.equal(db.prepare('SELECT status FROM threads WHERE id = ?').get(tid).status, 'done');
  assert.equal(closeIfAnswered(db, db.prepare('SELECT * FROM threads WHERE id = ?').get(tid), [cust, hal]), false, 'already closed');
});

test('CC rule: a customer writing To a teammate with us only in CC is the teammate\'s (完了, no draft); To us directly is ours', async () => {
  const cc = gmailMsg({ id: 'cc1', threadId: 'TCC', from: '名古屋 <info@waterlab.example>', extraHeaders: [{ name: 'To', value: 'Hal <hal@example.com>' }, { name: 'Cc', value: 'leo@example.com' }] });
  const direct = gmailMsg({ id: 'd1', threadId: 'TD', from: '名古屋 <info@waterlab.example>', extraHeaders: [{ name: 'To', value: 'leo@example.com' }, { name: 'Cc', value: 'hal@example.com' }] });
  let drafted = 0;
  const ai = { async complete(req) { if (req.operation === 'draft') drafted += 1; return { text: '{"label":"inquiry","confidence":0.9}', model: 'm', tokens_in: 1, tokens_out: 1, cost_usd: 0 }; } };
  const g = { ...fakeGmail({ cc1: cc, d1: direct }), listSpam: async () => [] };
  await ingestMailbox({ db, mailbox: mailbox(), ai, config: { ...config, drafting: false }, gmailFactory: () => g });
  const st = Object.fromEntries(db.prepare('SELECT gmail_thread_id g, status FROM threads').all().map((r) => [r.g, r.status]));
  assert.deepEqual(st, { TCC: 'done', TD: 'new' });
});
