// Calendar plan step 13: confirm flow, Meet, confirmation draft and undo (D9, D10, D11, D29 + D40, D33, D37, D38).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { fakeGoogle } from './fake-calendar.js';

const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', aiDailyCapUsd: 5 };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const DAY = 86_400_000;
const START = new Date(Date.now() + 3 * DAY); START.setUTCHours(1, 0, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const msg = (text) => ({
  id: 'm1', threadId: 'GT1', labelIds: ['INBOX'], internalDate: String(Date.now() - 3600_000),
  payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: 'Acme <a@acme.jp>' }, { name: 'Subject', value: 'お打ち合わせ' }, { name: 'Message-ID', value: '<x@acme.jp>' },
  ], body: { data: b64(text) } },
});

let db; let biz; let leo; let gus; let info; let thr; let partnerId; let g; let prompts; let mail;
beforeEach(() => {
  db = openDb(':memory:');
  biz = newId(); leo = newId(); gus = newId(); info = newId(); thr = newId(); partnerId = newId(); prompts = [];
  mail = [msg('11/12 10:00 でお願いします')];
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access, calendar_mode, hold_calendar_id) VALUES (?, 'Tobira', 'active', 'delegated', 'on', 'hold@group')").run(biz);
  const m = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, ?, ?, 'connected', 'live', 0)");
  m.run(leo, biz, 'leo@example.com', encrypt('r', masterKey)); m.run(gus, biz, 'gus@example.com', encrypt('r', masterKey)); m.run(info, biz, 'info@example.com', encrypt('r', masterKey));
  db.prepare('UPDATE businesses SET hold_calendar_owner_mailbox_id = ? WHERE id = ?').run(info, biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'leo@example.com', 'owner')").run(newId(), biz);
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'p@partner.jp', 'partner')").run(partnerId, biz);
  db.prepare('INSERT INTO partner_mailboxes (user_id, business_id, mailbox_id, can_send) VALUES (?, ?, ?, 0)').run(partnerId, biz, leo);
  const v = newId();
  db.prepare("INSERT INTO voice_profiles (id, business_id, full_name, signature) VALUES (?, ?, '大野', '大野')").run(v, biz);
  db.prepare('UPDATE mailboxes SET voice_profile_id = ? WHERE business_id = ?').run(v, biz);
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, label_key, status, cache_from, cache_subject, last_message_at)
    VALUES (?, ?, ?, 'GT1', 'booking', 'new', 'Acme <a@acme.jp>', 'お打ち合わせ', ?)`).run(thr, biz, leo, new Date().toISOString());
  g = fakeGoogle();
});

const ai = { complete: async (req) => { prompts.push(JSON.stringify(req)); return { text: 'Acme様\n\nご連絡ありがとうございます。\n\n大野', model: req.model, tokens_in: 1, tokens_out: 1, cost_usd: 0 }; } };
function suggestion({ mailbox = leo, start = iso(START.getTime()), statedTz = null } = {}) {
  const id = newId();
  db.prepare(`INSERT INTO suggestions (id, business_id, mailbox_id, thread_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, end_utc, kind, counterpart_label, stated_tz, message_at, created_at)
    VALUES (?, ?, ?, ?, 'GT1', ?, 'theirs', 'ai', ?, NULL, 'confirm', 'Acme', ?, ?, ?)`).run(id, biz, mailbox, mailbox === leo ? thr : null, `m-${id}`, start, statedTz, iso(Date.now() - DAY), iso(Date.now() - DAY));
  return id;
}
async function as(email, google = g) {
  const app = buildApp({ db, config, ai, exchange: async () => ({ id_token: idToken(email) }), calendarClientFor: google.clientFor,
    gmailFactory: () => ({ getThread: async () => ({ messages: mail }) }), meetWait: { wait: async () => {} } });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return (method, url, payload) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}
const one = (sql, ...a) => db.prepare(sql).get(...a);

test('a partner without send rights gets 403 and nothing is written; one without sight cannot read the suggestion', async () => {
  const sid = suggestion();
  const p = await as('p@partner.jp');
  const r = await p('POST', '/api/meetings/confirm', { suggestionId: sid });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error, 'partner_cannot_send');
  const other = suggestion({ mailbox: gus });
  assert.equal((await p('POST', '/api/meetings/confirm', { suggestionId: other })).statusCode, 403);
  assert.equal(g.writes().length, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM meetings').n, 0);
});

test('confirm writes the event on the mailbox calendar (no attendees, sendUpdates none, Meet requestId = meeting id), then drafts with the link; leftover holds go', async () => {
  const sid = suggestion();
  const leftover = suggestion({ start: iso(START.getTime() + DAY) });
  const hold = newId();
  db.prepare("INSERT INTO holds (id, business_id, suggestion_id, state, expires_at) VALUES (?, ?, ?, 'active', ?)").run(hold, biz, leftover, iso(START.getTime() + DAY));
  const { placeHold } = await import('../src/calendar-writes.js');
  await placeHold({ db, businessId: biz, hold: one('SELECT * FROM holds WHERE id = ?', hold), summary: '仮: Acme', startUtc: iso(START.getTime() + DAY), endUtc: iso(START.getTime() + DAY + 1800_000), clientFor: g.clientFor });
  db.prepare("UPDATE suggestions SET state = 'held' WHERE id = ?").run(leftover);

  const owner = await as('leo@example.com');
  const r = await owner('POST', '/api/meetings/confirm', { suggestionId: sid });
  assert.equal(r.statusCode, 200, r.body);
  const m = one('SELECT * FROM meetings');
  const ins = g.writes().find((c) => c.method === 'POST' && c.calId === 'leo@example.com');
  assert.equal(ins.q.sendUpdates, 'none');
  assert.equal(ins.q.conferenceDataVersion, '1');
  assert.equal(ins.body.attendees, undefined);
  assert.equal(ins.body.conferenceData.createRequest.requestId, m.id);
  assert.equal(Date.parse(ins.body.end.dateTime) - Date.parse(ins.body.start.dateTime), 30 * 60_000, 'D38: 30 minutes');
  assert.deepEqual([m.conference_status, m.link_source], ['ready', 'meet']);
  assert.match(m.link_url, /^https:\/\/meet\.google\.com\//);
  const d = one('SELECT * FROM drafts WHERE meeting_id = ?', m.id);
  assert.equal(d.meeting_purpose, 'confirm');
  assert.ok(d.body_text.includes(m.link_url));
  assert.match(prompts.at(-1), /日程が確定/);
  assert.equal(one('SELECT state FROM holds WHERE id = ?', hold).state, 'confirmed_away');
  assert.equal(g.cal('hold@group').size, 0);
  assert.equal(one('SELECT state FROM suggestions WHERE id = ?', leftover).state, 'superseded');
  // Double submit: the same meeting, no second event.
  const again = await owner('POST', '/api/meetings/confirm', { suggestionId: sid });
  assert.equal(again.json().meeting.id, m.id);
  assert.equal(g.cal('leo@example.com').size, 1);
});

test('a failed Google write makes no draft and keeps the calendar_writes row; a retry makes one event', async () => {
  const g2 = fakeGoogle({ failInserts: 1 });
  const sid = suggestion();
  const owner = await as('leo@example.com', g2);
  const r = await owner('POST', '/api/meetings/confirm', { suggestionId: sid });
  assert.equal(r.statusCode, 502);
  assert.equal(one('SELECT COUNT(*) AS n FROM drafts WHERE meeting_id IS NOT NULL').n, 0);
  assert.equal(prompts.length, 0);
  assert.equal(one("SELECT status FROM calendar_writes WHERE kind = 'meeting_confirm'").status, 'failed');
  const ok = await owner('POST', '/api/meetings/confirm', { suggestionId: sid });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(g2.cal('leo@example.com').size, 1);
  assert.equal(one("SELECT status FROM calendar_writes WHERE kind = 'meeting_confirm'").status, 'ok');
});

test('a pending conference is polled until ready', async () => {
  const g2 = fakeGoogle({ meetReadyAfter: 3 });
  const owner = await as('leo@example.com', g2);
  const r = await owner('POST', '/api/meetings/confirm', { suggestionId: suggestion() });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().meeting.conference, 'ready');
  assert.ok(r.json().draft.body.includes(r.json().meeting.link));
});

test('a conference still pending after 5 polls leaves a 【要確認】 blank, so the send is refused', async () => {
  const g2 = fakeGoogle({ meetReadyAfter: Infinity });
  const owner = await as('leo@example.com', g2);
  const r = await owner('POST', '/api/meetings/confirm', { suggestionId: suggestion() });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().meeting.conference, 'pending');
  assert.equal(g2.calls.filter((c) => c.method === 'GET' && c.evId).length, 5);
  assert.match(r.json().draft.body, /【要確認：会議リンク/);
  const send = await owner('POST', `/api/threads/${thr}/send`, { draftId: r.json().draft.id });
  assert.equal(send.statusCode, 409);
  assert.equal(send.json().error, 'blanks_left');
});

test('a link in the mail is used: no Meet is created; in person puts the address in location', async () => {
  mail = [msg('Zoom: https://us02web.zoom.us/j/123456789 でお願いします')];
  const owner = await as('leo@example.com');
  const r = await owner('POST', '/api/meetings/confirm', { suggestionId: suggestion() });
  assert.equal(r.json().meeting.linkSource, 'mail');
  const ins = g.writes().find((c) => c.method === 'POST');
  assert.equal(ins.body.conferenceData, undefined);
  assert.equal(ins.q.conferenceDataVersion, undefined);
  mail = [msg('よろしくお願いします')];
  const r2 = await owner('POST', '/api/meetings/confirm', { mailboxId: leo, threadId: thr, start: iso(START.getTime() + 2 * DAY), place: '東京都渋谷区1-2-3' });
  assert.equal(r2.statusCode, 200, r2.body);
  const ins2 = g.writes().filter((c) => c.method === 'POST').at(-1);
  assert.equal(ins2.body.location, '東京都渋谷区1-2-3');
  assert.equal(ins2.body.conferenceData, undefined);
});

test('undo deletes our event with sendUpdates none, restores suggestions and drafts a correction once the confirmation went out', async () => {
  const sid = suggestion();
  const owner = await as('leo@example.com');
  const c = (await owner('POST', '/api/meetings/confirm', { suggestionId: sid })).json();
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(c.draft.id);
  const r = await owner('POST', `/api/meetings/${c.meeting.id}/undo`);
  assert.equal(r.statusCode, 200, r.body);
  const del = g.writes().find((x) => x.method === 'DELETE');
  assert.equal(del.q.sendUpdates, 'none');
  assert.ok(del.ifMatch);
  assert.equal(g.cal('leo@example.com').size, 0);
  assert.equal(one('SELECT state FROM meetings WHERE id = ?', c.meeting.id).state, 'undone');
  assert.equal(one('SELECT state FROM suggestions WHERE id = ?', sid).state, 'suggested');
  assert.equal(r.json().draft && one('SELECT meeting_purpose FROM drafts WHERE id = ?', r.json().draft.id).meeting_purpose, 'correction');
  assert.match(prompts.at(-1), /誤り/);
});

test('undo before the confirmation was sent discards it and drafts no correction', async () => {
  const owner = await as('leo@example.com');
  const c = (await owner('POST', '/api/meetings/confirm', { suggestionId: suggestion() })).json();
  const n = prompts.length;
  const r = await owner('POST', `/api/meetings/${c.meeting.id}/undo`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().draft, null);
  assert.equal(prompts.length, n);
  assert.equal(one('SELECT status FROM drafts WHERE id = ?', c.draft.id).status, 'discarded');
});

test('calendar_mode off: confirm is 404 and nothing reaches Google', async () => {
  const sid = suggestion();
  db.prepare("UPDATE businesses SET calendar_mode = 'off' WHERE id = ?").run(biz);
  const owner = await as('leo@example.com');
  assert.equal((await owner('POST', '/api/meetings/confirm', { suggestionId: sid })).statusCode, 404);
  assert.equal(g.calls.length, 0);
});
