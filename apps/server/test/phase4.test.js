import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId, Store } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { deliverDue } from '../src/send-queue.js';
import { gmailTransport } from '../src/transport.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, adminToken: 'tok', publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 0.5 };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;

let db; let A; let B; let sentRaw;
function gm(threadMsgs) {
  return () => ({
    getThread: async () => ({ messages: threadMsgs }),
    sendRaw: async (raw, threadId) => { sentRaw.push({ raw, threadId }); return { id: 'gm-sent-1' }; },
    modifyThread: async () => {}, labels: async () => [], createLabel: async (n) => ({ id: n, name: n }),
  });
}
const inbound = {
  id: 'm1', threadId: 'GT1', labelIds: ['INBOX'], internalDate: '1793840000000',
  payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: '森田 <info@sample-kitchen.jp>' }, { name: 'Subject', value: '英語ページのご相談' },
    { name: 'Message-ID', value: '<abc@sample-kitchen.jp>' }, { name: 'Date', value: 'Wed, 4 Nov 2026 10:00:00 +0900' },
  ], body: { data: b64('見てみたいです。') } },
};

function seed(name, email, mode = 'shadow') {
  const biz = newId(); const user = newId(); const mbx = newId(); const thr = newId();
  db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, ?, 'active')").run(biz, name);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, ?, 'owner')").run(user, biz, email);
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, ?, ?, 'connected', ?, 0)")
    .run(mbx, biz, email, encrypt('r', masterKey), mode);
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from, cache_subject, cache_snippet, last_message_at)
    VALUES (?, ?, ?, 'GT1', 'inquiry', 'new', '森田 <info@sample-kitchen.jp>', '英語ページのご相談', '見てみたいです。', '2026-11-04T01:00:00Z')`).run(thr, biz, mbx);
  const draft = new Store(db, biz).saveDraft({ threadId: thr, bodyText: '森田様\n\nお世話になっております。\n料金は【要確認：金額】です。', createdBy: 'ai' });
  return { biz, user, mbx, thr, draft };
}

async function login(app, email) {
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  return { status: cb.statusCode, cookie: String(cb.headers['set-cookie'] ?? '').split(';')[0] };
}

beforeEach(() => {
  db = openDb(':memory:'); sentRaw = [];
  A = seed('Example Studio', 'leo@example.com');
  B = seed('Acme Shop', 'hello@acme-shop.example');
});

function appFor(email, threadMsgs = [inbound]) {
  return buildApp({ db, config, exchange: async () => ({ id_token: idToken(email) }), gmailFactory: gm(threadMsgs) });
}

test('console shell and vendored Preact are served; API needs sign-in', async () => {
  const app = appFor('leo@example.com');
  const root = await app.inject('/');
  assert.equal(root.statusCode, 200);
  assert.match(root.body, /TobirAInbox/);
  assert.match(root.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await app.inject('/vendor/htm-preact.js')).statusCode, 200);
  assert.equal((await app.inject('/api/me')).statusCode, 401);
});

test('sign-in: invited user gets a session; uninvited address is refused', async () => {
  const ok = await login(appFor('leo@example.com'), 'leo@example.com');
  assert.equal(ok.status, 302);
  assert.match(ok.cookie, /^tbi_session=/);
  const no = await login(appFor('stranger@gmail.com'), 'stranger@gmail.com');
  assert.equal(no.status, 403);
});

test('each company only sees its own threads, even when guessing another id', async () => {
  const app = appFor('leo@example.com');
  const { cookie } = await login(app, 'leo@example.com');
  for (const view of ['todo', 'unconfirmed', 'inbox', 'sent', 'done', 'all']) {
    assert.equal((await app.inject({ url: `/api/threads?view=${view}&mailbox=${A.mbx}`, headers: { cookie } })).statusCode, 200, view);
  }
  const list = (await app.inject({ url: '/api/threads?view=todo', headers: { cookie } })).json();
  assert.equal(list.counts.todo, 1);
  db.prepare("UPDATE threads SET label_key = 'notice' WHERE id = ?").run(A.thr);
  const after = (await app.inject({ url: '/api/threads?view=todo', headers: { cookie } })).json();
  assert.equal(after.counts.todo, 0, 'newsletters are not to-do');
  assert.equal(after.counts.inbox, 1);
  db.prepare("UPDATE threads SET label_key = 'inquiry' WHERE id = ?").run(A.thr);
  assert.deepEqual(list.threads.map((t) => t.id), [A.thr]);
  assert.equal((await app.inject({ url: `/api/threads/${B.thr}`, headers: { cookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/drafts/${B.draft}`, headers: { cookie }, payload: { body: 'x' } })).statusCode, 404);
  const me = (await app.inject({ url: '/api/me', headers: { cookie } })).json();
  assert.equal(me.business.name, 'Example Studio');
  // Calendar tab gate (plan step 17, D45): off until an admin switches the business on.
  assert.deepEqual(me.calendar, { mode: 'off', timezone: 'Asia/Tokyo', visible: false });
  assert.equal((await app.inject('/calendar.js')).statusCode, 200);
  assert.equal(me.business.undoSeconds, 30);
});

test('thread detail reads Gmail live; editing saves a new version; relabel works', async () => {
  const app = appFor('leo@example.com');
  const { cookie } = await login(app, 'leo@example.com');
  const d = (await app.inject({ url: `/api/threads/${A.thr}`, headers: { cookie } })).json();
  assert.equal(d.messages[0].body, '見てみたいです。');
  assert.deepEqual(d.draft.blanks, ['金額']);
  const put = (await app.inject({ method: 'PUT', url: `/api/drafts/${d.draft.id}`, headers: { cookie }, payload: { body: '森田様\n\nお世話になっております。' } })).json();
  assert.equal(put.draft.version, 2);
  assert.equal(put.draft.createdBy, 'user');
  assert.equal((await app.inject({ method: 'POST', url: `/api/threads/${A.thr}/label`, headers: { cookie }, payload: { label: 'question' } })).statusCode, 200);
  assert.equal(db.prepare('SELECT label_key FROM threads WHERE id = ?').get(A.thr).label_key, 'question');
});

test('send: refused in trial mode and with blanks; when live it queues, can be undone, then sends a threaded reply via Gmail', async () => {
  const app = appFor('leo@example.com');
  const { cookie } = await login(app, 'leo@example.com');
  const send = (body) => app.inject({ method: 'POST', url: `/api/threads/${A.thr}/send`, headers: { cookie }, payload: body });
  let r = await send({ draftId: A.draft, body: '森田様\n\nありがとうございます。' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'mailbox_not_live');

  db.prepare("UPDATE mailboxes SET mode = 'live' WHERE id = ?").run(A.mbx);
  const latest = () => db.prepare("SELECT id FROM drafts WHERE thread_id = ? AND status = 'open' ORDER BY version DESC").get(A.thr).id;
  r = await send({ draftId: latest() });
  assert.equal(r.json().error, 'blanks_left');

  r = await send({ draftId: latest(), body: '森田様\n\nお世話になっております。\nありがとうございます。' });
  assert.equal(r.statusCode, 200);
  const { sendId, undoUntil } = r.json();
  assert.ok(new Date(undoUntil) - Date.now() > 25_000, '30 s undo window');
  assert.equal((await app.inject({ method: 'POST', url: `/api/sends/${sendId}/undo`, headers: { cookie }, payload: {} })).statusCode, 200);

  r = await send({ draftId: latest(), body: '森田様\n\nお世話になっております。\nありがとうございます。' });
  const transport = gmailTransport(db, config, { gmailFactory: gm([inbound]) });
  assert.deepEqual(await deliverDue(db, transport, { now: new Date() }), [], 'nothing before the window closes');
  const out = await deliverDue(db, transport, { now: new Date(Date.now() + 31_000) });
  assert.deepEqual(out.map((x) => x.status), ['sent']);
  assert.equal(sentRaw.length, 1);
  assert.equal(sentRaw[0].threadId, 'GT1');
  const mime = Buffer.from(sentRaw[0].raw, 'base64url').toString('utf8');
  assert.match(mime, /In-Reply-To: <abc@sample-kitchen.jp>/);
  assert.match(mime, /To: =\?UTF-8\?B\?.+\?= <info@sample-kitchen.jp>/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.equal(db.prepare('SELECT status FROM threads WHERE id = ?').get(A.thr).status, 'sent');
});

test('sign-out ends the session', async () => {
  const app = appFor('leo@example.com');
  const { cookie } = await login(app, 'leo@example.com');
  await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie }, payload: {} });
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode, 401);
});

test('draft stream: text arrives as the model writes it, then the stored draft', async () => {
  const v = newId();
  db.prepare("INSERT INTO voice_profiles (id, business_id, full_name, signature) VALUES (?, ?, '大野', '大野 / Example Studio')").run(v, A.biz);
  db.prepare('UPDATE mailboxes SET voice_profile_id = ? WHERE id = ?').run(v, A.mbx);
  let seen;
  const ai = { complete: async (req) => {
    seen = req;
    const parts = ['Dear Morita,', '\n\nThank you.', '\n\nMori'];
    for (const p of parts) req.onText?.(p);
    return { text: parts.join(''), model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0 };
  } };
  const app = buildApp({ db, config, ai, exchange: async () => ({ id_token: idToken('leo@example.com') }), gmailFactory: gm([inbound]) });
  const { cookie } = await login(app, 'leo@example.com');
  const res = await app.inject({ method: 'POST', url: `/api/threads/${A.thr}/draft?stream=1`, headers: { cookie }, payload: { instruction: 'Rewrite the reply in English.', current: '森田様' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  const events = res.body.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
  assert.deepEqual(events.filter((e) => e.t === 'd').map((e) => e.v), ['Dear Morita,', '\n\nThank you.', '\n\nMori']);
  const done = events.find((e) => e.t === 'done');
  assert.ok(done.draft.body.startsWith('Dear Morita,'));
  // the language rule yields to an explicit rewrite request
  assert.match(`${seen.cacheable ?? ''}${seen.variable ?? seen.prompt ?? ''}`, /unless the rewrite request/);
});

test('one email CC\'d to two of our mailboxes is one row, and handling one closes the copy', async () => {
  const m2 = newId(); const t2 = newId();
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'mia@example.com', ?, 'connected', 'shadow', 0)").run(m2, A.biz, encrypt('r', masterKey));
  db.prepare("UPDATE threads SET last_rfc_message_id = '<same@sample-kitchen.jp>' WHERE id = ?").run(A.thr);
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from, cache_subject, last_message_at, last_rfc_message_id)
    VALUES (?, ?, ?, 'GT9', 'inquiry', 'new', '森田 <info@sample-kitchen.jp>', '英語ページのご相談', '2026-11-04T01:00:00Z', '<same@sample-kitchen.jp>')`).run(t2, A.biz, m2);
  const app = appFor('leo@example.com');
  const { cookie } = await login(app, 'leo@example.com');
  const list = (await app.inject({ url: '/api/threads?view=todo', headers: { cookie } })).json();
  assert.equal(list.threads.length, 1);
  assert.equal(list.threads[0].id, A.thr); // the copy with a draft leads
  assert.deepEqual(list.threads[0].alsoTo, ['mia@example.com']);
  assert.equal(list.counts.todo, 1);
  await app.inject({ method: 'POST', url: `/api/threads/${A.thr}/status`, headers: { cookie }, payload: { status: 'done' } });
  assert.equal(db.prepare('SELECT status FROM threads WHERE id = ?').get(t2).status, 'done');
});

test('versions: a rewrite keeps the person\'s edit as its own version, and all versions are listed', async () => {
  const v = newId();
  db.prepare("INSERT INTO voice_profiles (id, business_id, full_name, signature) VALUES (?, ?, '大野', '大野')").run(v, A.biz);
  db.prepare('UPDATE mailboxes SET voice_profile_id = ? WHERE id = ?').run(v, A.mbx);
  const ai = { complete: async (req) => ({ text: '森田様\n\n短くしました。\n\n大野', model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0 }) };
  const app = buildApp({ db, config, ai, exchange: async () => ({ id_token: idToken('leo@example.com') }), gmailFactory: gm([inbound]) });
  const { cookie } = await login(app, 'leo@example.com');
  await app.inject({ method: 'POST', url: `/api/threads/${A.thr}/draft`, headers: { cookie }, payload: { instruction: 'もっと短く', current: '森田様\n\n私が直した文です。' } });
  const { versions } = (await app.inject({ url: `/api/threads/${A.thr}/versions`, headers: { cookie } })).json();
  assert.deepEqual(versions.map((x) => [x.by, x.note]), [['ai', 'もっと短く'], ['user', '手直し'], ['ai', null]]);
  assert.match(versions[1].body, /私が直した文/);
  assert.equal((await app.inject({ url: `/api/threads/${B.thr}/versions`, headers: { cookie } })).statusCode, 404);
});

test('rules carry a phase; the draft prompt tags them', async () => {
  const { buildDraftPrompt } = await import('@tobira-inbox/engine');
  const p = buildDraftPrompt({ latest: { body: 'x' }, playbook: [{ text: '見積書を先に送る。', phase: 'deal' }, { text: '短く書く。' }] });
  assert.match(p.prompt, /\[見積・契約のとき\] 見積書を先に送る。/);
  assert.match(p.prompt, /2\. 短く書く。/);
});

test('history search runs on the server (from / subject), with % and _ taken literally', async () => {
  const app = appFor('leo@example.com');
  const { cookie } = await login(app, 'leo@example.com');
  const hit = (await app.inject({ url: `/api/threads?view=all&q=${encodeURIComponent('英語ページ')}`, headers: { cookie } })).json();
  assert.equal(hit.threads.length, 1);
  const miss = (await app.inject({ url: `/api/threads?view=all&q=${encodeURIComponent('100%_x')}`, headers: { cookie } })).json();
  assert.equal(miss.threads.length, 0);
});

test('D8: one person in two businesses: signs in to the last one used, can switch, cannot switch into a stranger\'s', async () => {
  db.prepare("INSERT INTO users (id, business_id, email, role, last_login_at) VALUES (?, ?, 'leo@example.com', 'partner', '2000-01-01')").run(newId(), B.biz);
  db.prepare("UPDATE users SET last_login_at = '2026-11-01' WHERE id = ?").run(A.user);
  const app = appFor('leo@example.com');
  const { cookie } = await login(app, 'leo@example.com');
  const me = (await app.inject({ url: '/api/me', headers: { cookie } })).json();
  assert.equal(me.business.name, 'Example Studio');
  assert.deepEqual(me.businesses.map((b) => [b.name, b.role, b.current]), [['Acme Shop', 'partner', false], ['Example Studio', 'owner', true]]);
  const sw = await app.inject({ method: 'POST', url: '/api/me/switch', headers: { cookie }, payload: { businessId: B.biz } });
  assert.equal(sw.statusCode, 200);
  const cookie2 = String(sw.headers['set-cookie']).split(';')[0];
  const me2 = (await app.inject({ url: '/api/me', headers: { cookie: cookie2 } })).json();
  assert.equal(me2.business.name, 'Acme Shop'); assert.equal(me2.user.role, 'partner');
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode, 401, 'old session is gone');
  const other = newId(); db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Stranger', 'active')").run(other);
  assert.equal((await app.inject({ method: 'POST', url: '/api/me/switch', headers: { cookie: cookie2 }, payload: { businessId: other } })).statusCode, 404);
});

test('history hides machine mail (DMARC, security alerts, newsletters) under お知らせ・自動; archive and trash take mail off screen and undo brings it back', async () => {
  const add = (from, label, status = 'done') => { const id = newId(); db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 's', '2026-11-01T00:00:00Z')`).run(id, A.biz, A.mbx, `G-${id}`, label, status, from); return id; };
  add('noreply-dmarc-support@google.com', 'unconfirmed'); add('Google <no-reply@accounts.google.com>', 'unconfirmed'); add('Reddit <noreply@redditmail.com>', 'notice');
  const real = add('山田 <yamada@ryokan.jp>', 'inquiry');
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken('leo@example.com') }), gmailFactory: () => ({ ...gm([inbound])(), call: async () => ({}) }) });
  const { cookie } = await login(app, 'leo@example.com');
  const get = async (v) => (await app.inject({ url: `/api/threads?view=${v}`, headers: { cookie } })).json().threads.map((x) => x.from);
  assert.deepEqual((await get('all')).sort(), ['山田 <yamada@ryokan.jp>', '森田 <info@sample-kitchen.jp>'].sort());
  assert.equal((await get('noise')).length, 3);
  const r = (await app.inject({ method: 'POST', url: `/api/threads/${real}/archive`, headers: { cookie }, payload: { trash: true } })).json();
  assert.equal(r.prevStatus, 'done');
  assert.ok(!(await get('all')).includes('山田 <yamada@ryokan.jp>'));
  await app.inject({ method: 'POST', url: `/api/threads/${real}/archive`, headers: { cookie }, payload: { undo: true, prevStatus: 'done' } });
  assert.ok((await get('all')).includes('山田 <yamada@ryokan.jp>'));
});

test('要確認 counts only open mail: an old, already-answered conversation from the history backfill does not', async () => {
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, 'OLD', 'unconfirmed', 'sent', 'Someone <a@b.jp>', 'old', '2025-01-01T00:00:00Z')`).run(newId(), A.biz, A.mbx);
  const app = appFor('leo@example.com');
  const { cookie } = await login(app, 'leo@example.com');
  const { counts } = (await app.inject({ url: '/api/threads?view=todo', headers: { cookie } })).json();
  assert.equal(counts.unconfirmed, 0);
});

test('更新 (manual sync) checks every connected mailbox now, reports failures, and is not hammered twice in a row', async () => {
  db.prepare("UPDATE mailboxes SET mode = 'live', history_id = '1' WHERE id = ?").run(A.mbx);
  let polled = 0;
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken('leo@example.com') }),
    gmailFactory: () => ({ ...gm([inbound])(), historySince: async () => { polled += 1; return { messageIds: [], historyId: '2' }; }, listSpam: async () => [] }) });
  const { cookie } = await login(app, 'leo@example.com');
  const r = (await app.inject({ method: 'POST', url: '/api/sync', headers: { cookie }, payload: {} })).json();
  assert.equal(r.ok, true); assert.equal(polled, 1); assert.deepEqual(r.errors, []);
  const again = (await app.inject({ method: 'POST', url: '/api/sync', headers: { cookie }, payload: {} })).json();
  assert.equal(again.recent, true); assert.equal(polled, 1);
});

test('links: the customer\'s site (signature URL or email domain, not webmail) and the Tobira preview we sent appear on the thread', async () => {
  const { threadLinks } = await import('../src/links.js');
  const own = (a) => /@example\.com$/.test(a);
  const r = threadLinks([
    { from: 'leo@example.com', full: 'サンプルです → https://example.com/asobiba-preview/?feedback=1 。ご確認ください' },
    { from: '中村 <nakamura@viva.example>', full: '拝見しました。\n会社HP : www.viva.example/company\nhttps://zoom.us/j/123' },
    { from: 'Guest <guest@gmail.com>', full: 'hi' },
  ], { isOwn: own });
  assert.deepEqual(r.previews, ['https://example.com/asobiba-preview/']);
  assert.deepEqual(r.sites, ['https://viva.example/']);
});

test('attachments: upload to the reply, remove, size cap, and sent with the reply (then marked sent)', async () => {
  const app = appFor('leo@example.com');
  const { cookie } = await login(app, 'leo@example.com');
  const up = (name, bytes) => app.inject({ method: 'POST', url: `/api/threads/${A.thr}/attachments`, headers: { cookie }, payload: { filename: name, mimeType: 'application/pdf', data: Buffer.alloc(bytes, 1).toString('base64') } });
  const f = (await up('御見積書.pdf', 1000)).json().file;
  assert.equal(f.filename, '御見積書.pdf');
  assert.equal((await up('big.pdf', 10 * 1024 * 1024)).statusCode, 413);
  const g = (await up('extra.pdf', 10)).json().file;
  await app.inject({ method: 'DELETE', url: `/api/threads/${A.thr}/attachments/${g.id}`, headers: { cookie } });
  const view = (await app.inject({ url: `/api/threads/${A.thr}`, headers: { cookie } })).json();
  assert.deepEqual(view.outgoing.map((x) => x.filename), ['御見積書.pdf']);
  assert.equal((await app.inject({ method: 'POST', url: `/api/threads/${B.thr}/attachments`, headers: { cookie }, payload: { filename: 'x', data: 'eA==' } })).statusCode, 404, 'other company');
  // the transport puts it in the MIME and the queue marks it sent
  db.prepare("UPDATE mailboxes SET mode = 'live' WHERE id = ?").run(A.mbx);
  const tr = gmailTransport(db, config, { gmailFactory: gm([inbound]) });
  const s = new Store(db, A.biz);
  const d = s.latestDraft(A.thr);
  const sendId = newId();
  db.prepare("INSERT INTO sends (id, business_id, draft_id, user_id, idempotency_key, body_text, queued_at, undo_until) VALUES (?, ?, ?, ?, ?, '森田様\n\nお送りします。', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')").run(sendId, A.biz, d.id, A.user, sendId);
  await deliverDue(db, tr, { now: new Date() });
  const raw = Buffer.from(sentRaw.at(-1).raw, 'base64url').toString('utf8');
  assert.match(raw, /multipart\/mixed/);
  // RFC 2047 encoded word: Gmail's send API keeps it (it dropped RFC 2231 filename* and left "___.pdf").
  const word = `=?UTF-8?B?${Buffer.from('御見積書.pdf').toString('base64')}?=`;
  assert.ok(raw.includes(`filename="${word}"`) && raw.includes(`name="${word}"`), 'Japanese file name as an encoded word');
  assert.doesNotMatch(raw, /filename="_+\.pdf"/);
  assert.ok(db.prepare('SELECT sent_at FROM thread_attachments WHERE id = ?').get(f.id).sent_at);
});

test('a received attachment opens by its position, though Gmail gives a new (400-character) id on every fetch; Japanese name kept', async () => {
  let n = 0;
  const msgWith = () => ({ ...inbound, payload: { mimeType: 'multipart/mixed', headers: inbound.payload.headers, parts: [
    { mimeType: 'text/plain', body: { data: b64('添付します。') } },
    { mimeType: 'text/plain', filename: 'お見積り_テスト.txt', body: { attachmentId: `ANGjdJ${n += 1}${'x'.repeat(400)}`, size: 5 } },
  ] } });
  let fetched;
  const app = buildApp({ db, config, exchange: async () => ({ id_token: idToken('leo@example.com') }),
    gmailFactory: () => ({ ...gm([msgWith()])(), getMessage: async () => msgWith(), call: async (_m, path) => { fetched = path; return { data: b64('hello') }; } }) });
  const { cookie } = await login(app, 'leo@example.com');
  const r = await app.inject({ url: `/api/threads/${A.thr}/files/m1/0`, headers: { cookie } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.body, 'hello');
  assert.match(fetched, /\/attachments\/ANGjdJ\d+x{400}$/, 'fetched with the fresh id');
  assert.ok(String(r.headers['content-disposition']).includes(`filename*=UTF-8''${encodeURIComponent('お見積り_テスト.txt')}`));
  assert.equal((await app.inject({ url: `/api/threads/${A.thr}/files/m1/${'y'.repeat(400)}`, headers: { cookie } })).statusCode, 404, 'a long stale id is not a 400');
});
