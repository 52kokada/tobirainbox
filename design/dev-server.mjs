// Local console preview with demo data: in-memory DB, fake Gmail, fake AI. Nothing leaves this machine.
//   node design/dev-server.mjs   → open http://127.0.0.1:8961/dev  (signs you in as the demo owner)
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDb } from '../apps/server/src/db.js';
import { newId, Store } from '../apps/server/src/store.js';
import { encrypt } from '../apps/server/src/crypto.js';
import { buildApp } from '../apps/server/src/app.js';
import { seedBusiness } from '../apps/server/bin/seed.js';
import { deliverDue } from '../apps/server/src/send-queue.js';
import { fromZoned } from '../apps/server/public/time.js';
import { ourTag } from '../apps/server/src/calendar-writes.js';
import { CalendarError } from '../apps/server/src/calendar.js';

const PORT = Number(process.env.PORT ?? 8961);
const masterKey = randomBytes(32).toString('base64');
const config = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: `http://127.0.0.1:${PORT}`, aiDailyCapUsd: 5 };
const db = openDb(':memory:');
const biz = newId();
db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, 'Example Studio', 'active')").run(biz);
db.prepare("INSERT INTO users (id, business_id, email, name, role) VALUES (?, ?, 'mia@example.com', '森', 'owner')").run(newId(), biz);
const mbx = {};
for (const a of ['leo', 'kit', 'mia', 'ada']) {
  mbx[a] = newId();
  db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, ?, ?, 'connected', 'live', 0)")
    .run(mbx[a], biz, `${a}@example.com`, encrypt('r', masterKey));
}
seedBusiness(db, JSON.parse(readFileSync(new URL('../apps/server/seeds/example.json', import.meta.url), 'utf8')));

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const THREADS = [
  { box: 'mia', from: '町家ステイ 綾 <info@machiya.example>', subject: 'Re: 英語ページのご提案', label: 'question', min: 60 * 20,
    msgs: [['mia', '綾 様\n\nExample Studio の森です。英語ページの無料サンプルをお作りしました。\nhttps://example.com/machiya-aya-preview/', 60 * 24 * 7],
      ['them', 'ご提案ありがとうございます。\n料金の目安を教えていただけますか。写真は来週お送りします。', 60 * 20]],
    draft: '綾 様\n\nご返信ありがとうございます。\n\n料金は掲載内容やページ数によって変わるため、まずは無料のサンプルをご覧いただいたうえで、お見積りをお送りしております。\nお写真は【要確認：送付先・送り方】にお送りいただければ、3 営業日ほどでサンプルをお作りします。\n\nどうぞよろしくお願いいたします。\n\n森 / Example Studio' },
  { box: 'ada', from: '湯宿 ひなた <reservation@onsen.example>', subject: 'ご予約の件について', label: 'unconfirmed', guess: 'booking', min: 40,
    msgs: [['them', 'いつもお世話になっております。\n来週の撮影の件、日程を調整させていただけますでしょうか。宿泊ではなく撮影のための訪問です。', 40]] },
  { box: 'leo', from: '佐藤 <sato@komorebi.example>', subject: 'Re: 英語ページのサンプル', label: 'inquiry', min: 120,
    msgs: [['leo', '佐藤 様\n\nExample Studio の大野です。こもれび様の英語ページのサンプルをお作りできればと思いご連絡しました。', 60 * 24 * 6],
      ['them', '見てみたいです。来月の連休前に間に合いますでしょうか。写真は何枚くらい必要ですか。', 120]],
    draft: '佐藤 様\n\nさっそくのご返信ありがとうございます。\n\n連休前に間に合うよう進められます。まずは英語版トップページの無料サンプルをお作りします。\nお写真は【要確認：写真の枚数】ほどご用意いただければ十分です。\n\nどうぞよろしくお願いいたします。\n\n大野 / Example Studio' },
  { box: 'mia', from: 'Emily Carter <emily.carter@example.com>', subject: 'Cooking class for 4 on Nov 20', label: 'booking', min: 180,
    msgs: [['them', 'Hi! We are visiting Tokyo with two kids (8 and 11). Is there a ramen or sushi class on Nov 20 in the afternoon? One of us is vegetarian.', 180]],
    draft: 'Dear Emily,\n\nThank you for your message. We would be happy to welcome your family.\nOur ramen class on Nov 20 starts at 【要確認：afternoon time slot】, and we can prepare a vegetarian broth.\n\nBest regards,\nMizuno' },
  { box: 'kit', from: '手しごと 器屋 <hello@utsuwaya.example>', subject: '打ち合わせ日の変更', label: 'booking_change', min: 60 * 26,
    msgs: [['them', '14日の打ち合わせを16日に変更は可能でしょうか。', 60 * 26]],
    draft: '器屋 様\n\nご連絡ありがとうございます。\n16日に変更で問題ございません。お時間は前回と同じ 14:00 からでよろしいでしょうか。\n\n健 / Example Studio' },
  { box: 'leo', from: '鎌倉 しおさい荘 <office@shiosai.example>', subject: 'Re: ホームページのご提案', label: 'inquiry', min: 60 * 50,
    msgs: [['leo', 'しおさい荘 様\n\nExample Studio の大野です。英語ページの無料サンプルのご案内でご連絡いたしました。', 60 * 24 * 8],
      ['them', 'ありがとうございます。社内で確認して改めてご連絡します。', 60 * 50]],
    draft: 'しおさい荘 様\n\nご返信ありがとうございます。\nどうぞごゆっくりご検討ください。ご不明な点があればいつでもご連絡ください。\n\n大野 / Example Studio' },
  { box: 'ada', from: 'Example Security <news@security.example>', subject: 'November product update', label: 'notice', min: 300,
    msgs: [['them', 'Here is what is new this month…', 300]] },
];
const gmailThreads = {};
const store = new Store(db, biz);
THREADS.forEach((t, i) => {
  const id = newId(); const gt = `GT${i}`;
  const msgs = t.msgs.map(([who, body, min], j) => ({
    id: `${gt}-M${j}`, threadId: gt, internalDate: String(Date.now() - min * 60_000), labelIds: [],
    payload: { mimeType: 'text/plain', headers: [
      { name: 'From', value: who === 'them' ? t.from : `${who}@example.com` }, { name: 'To', value: `${t.box}@example.com` },
      { name: 'Subject', value: t.subject }, { name: 'Date', value: new Date(Date.now() - min * 60_000).toUTCString() }],
      body: { data: Buffer.from(body).toString('base64url') } },
  }));
  gmailThreads[gt] = { id: gt, messages: msgs };
  const last = msgs.at(-1);
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, label_key, label_guess, label_by, status, cache_from, cache_subject, cache_snippet, last_message_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?, ?)`).run(id, biz, mbx[t.box], gt, last.id, t.label, t.guess ?? null, t.draft ? 'drafted' : 'new', t.from, t.subject, t.msgs.at(-1)[1].replace(/\n/g, ' ').slice(0, 120), ago(t.min));
  if (t.draft) { const d = store.saveDraft({ threadId: id, bodyText: t.draft, createdBy: 'ai' }); db.prepare('UPDATE drafts SET for_message_id = ? WHERE id = ?').run(last.id, d); }
});

// One email CC'd to two of us (kit@ and mia@): same Message-ID, two inbox copies.
{ const r = db.prepare("SELECT * FROM threads WHERE gmail_thread_id = 'GT4'").get();
  db.prepare("UPDATE threads SET last_rfc_message_id = '<cc-demo@utsuwaya.example>' WHERE id = ?").run(r.id);
  db.prepare(`INSERT INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, last_rfc_message_id, label_key, label_by, status, cache_from, cache_subject, cache_snippet, last_message_at)
    VALUES (?, ?, ?, 'GT4', ?, '<cc-demo@utsuwaya.example>', ?, 'ai', 'new', ?, ?, ?, ?)`).run(newId(), biz, mbx.mia, r.last_message_id, r.label_key, r.cache_from, r.cache_subject, r.cache_snippet, r.last_message_at); }
const gmailFactory = () => new Proxy({ getThread: async (gt) => gmailThreads[gt] }, { get: (o, k) => o[k] ?? (async () => ({})) });
// Fake AI: rewrites by simple rules so the console flow can be tried offline.
const ai = {
  complete: async (req) => {
    await new Promise((r) => setTimeout(r, 1500));
    if (req.operation === 'website') return { text: ['料金（英語ページ）: ¥150,000〜 | https://example.com/pricing', '営業時間: 平日 10:00〜18:00 | https://example.com/', 'サンプル制作: 無料・3営業日 | https://example.com/sample'].join('\n'), metered: true };
    if (req.operation === 'rules' && /REQUEST:/.test(req.prompt ?? '')) { const rule = req.prompt.match(/RULE: (.*)/)[1]; const ask = req.prompt.match(/REQUEST: (.*)/)[1]; return { text: `${rule.replace(/。$/, '')}（${ask}）。`, metered: true }; }
    if (req.operation === 'rules') return { text: ['inquiry | 「見てみたい」という返信には、無料サンプルを作ると約束し、写真の送り方を案内する。', 'booking_change | 日程変更の依頼には、まず変更可能と伝え、時間の確認を一つだけ聞く。'].join('\n'), metered: true };
    const v = String(req.variable ?? req.prompt ?? '');
    const cur = v.match(/CURRENT DRAFT:\n"""\n([\s\S]*?)\n"""/)?.[1];
    const ask = v.match(/Request: (.*)/)?.[1] ?? '';
    let text = cur || 'お問い合わせありがとうございます。\n撮影日について、来週は【要確認：候補日】でしたら伺えます。\n\nどうぞよろしくお願いいたします。\n\nExample Studio';
    if (cur && /short/i.test(ask + 'x') && /短く|shorter/i.test(ask)) { const p = cur.split(/\n\n+/); text = [p[0], p.at(-2), p.at(-1)].join('\n\n'); }
    else if (cur && /English/i.test(ask)) text = 'Dear customer,\n\nThank you for your reply. We will first make a free sample and then send a quote.\nPlease send the photos to 【要確認：address】.\n\nBest regards,\nExample Studio';
    else if (cur && /丁寧/.test(ask)) text = cur.replace('ありがとうございます。', '誠にありがとうございます。').replace('よろしくお願いいたします。', '何卒よろしくお願い申し上げます。');
    else if (cur) text = `${cur}\n\n（指示：${ask}）`;
    if (req.onText) for (const ch of text.match(/[\s\S]{1,3}/g) ?? []) { req.onText(ch); await new Promise((r) => setTimeout(r, 25)); }
    return { text, tokens_in: 0, tokens_out: 0, cost_usd: 0, model: req.model, metered: true };
  },
};
const idToken = `x.${Buffer.from(JSON.stringify({ email: 'mia@example.com', email_verified: true })).toString('base64url')}.y`;
const websiteFetcher = async (url) => ({ url, html: '<title>Example Studio</title><p>英語ページ ¥150,000〜。平日 10:00〜18:00。</p><a href="/pricing">料金</a>' });
for (const [i, ex] of [['予約できますか', '空き状況を確認して折り返します'], ['見てみたいです', '無料サンプルをお作りします'], ['日程を変えたい', '変更可能です。お時間だけ教えてください']].entries()) {
  db.prepare("INSERT INTO examples (id, business_id, label_key, incoming_redacted, reply_redacted) VALUES (?, ?, 'inquiry', ?, ?)").run(newId(), biz, ex[0] + i, ex[1] + i);
}
db.prepare("INSERT INTO label_corrections (business_id, from_label, to_label, from_domain, subject_redacted) VALUES (?, 'booking', 'question', 'onsen.example', 'ご予約の件について')").run(biz);
db.prepare("INSERT INTO playbook_rules (id, business_id, label_key, text, source, status) VALUES (?, ?, 'inquiry', '制作のご依頼の意向をいただいたら、すぐに契約書は送らず、御見積書を添付して内容のご確認をお願いする。', 'ai_proposed', 'proposed')").run(newId(), biz);
db.prepare("INSERT INTO alerts (id, business_id, kind, key, title, body, url) VALUES (?, ?, 'mailbox_error', ?, 'ada@example.com の接続が切れました', 'Google でアクセスが取り消されたか期限切れです。設定 → メールボックスから接続し直してください。', '/#settings')").run(newId(), biz, mbx.ada);
db.prepare("UPDATE threads SET in_spam = 1 WHERE gmail_thread_id = 'GT0'").run();
// ── Calendar preview (plan steps 12-17): calendar_mode on, demo rows for November 2026 in the real tables
// (suggestions, holds, meetings, the read cache of Google events), served by the real GET /api/calendar and
// /api/threads/:id. Google itself is a small in-memory fake, so hold / confirm / undo / free slots work
// offline. The viewer is mia@ (owner): others' private events reach the browser as busy blocks (D16).
const info = newId();
db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, 'info@example.com', ?, 'connected', 'paused', 0)")
  .run(info, biz, encrypt('r', masterKey));
db.prepare("UPDATE businesses SET calendar_mode = 'on', calendar_access = 'delegated', hold_calendar_id = 'hold@dev', hold_calendar_owner_mailbox_id = ? WHERE id = ?").run(info, biz);
for (const [a, n] of [['leo', '大野'], ['kit', '健'], ['ada', 'ニーナ']]) db.prepare("INSERT INTO users (id, business_id, email, name, role) VALUES (?, ?, ?, ?, 'staff')").run(newId(), biz, `${a}@example.com`, n);
const J = (d, h, m = 0, mo = 10) => fromZoned(2026, mo, d, h, m, 'Asia/Tokyo').toISOString();
const tid = (gt, box) => db.prepare('SELECT id FROM threads WHERE gmail_thread_id = ? AND mailbox_id = ?').get(gt, mbx[box])?.id ?? null;
const ZOOM = 'https://us06web.zoom.us/j/84512093377?pwd=Tb1raDemo';
const MEET = 'https://meet.google.com/kxe-wqpd-rmn';

// A tiny Google Calendar: events per calendar, ids and etags, freeBusy from the cache + holds.
const gcal = new Map(); let gn = 0;
const gcalOf = (id) => { if (!gcal.has(id)) gcal.set(id, new Map()); return gcal.get(id); };
const devCalendar = () => ({
  insertEvent: async (calId, ev, { conference } = {}) => {
    const out = { ...ev, status: 'confirmed', etag: `"d${++gn}"`, ...(conference ? { hangoutLink: `https://meet.google.com/dev-${ev.id.slice(0, 4)}-abc` } : {}) };
    gcalOf(calId).set(ev.id, out); return out;
  },
  getEvent: async (calId, id) => { const e = gcalOf(calId).get(id); if (!e) throw new CalendarError(404, {}); return e; },
  patchEvent: async (calId, id, patch) => { const e = gcalOf(calId).get(id); Object.assign(e, patch, { etag: `"d${++gn}"` }); return e; },
  deleteEvent: async (calId, id) => { gcalOf(calId).delete(id); return {}; },
  freeBusy: async ({ ids, timeMin, timeMax }) => Object.fromEntries(ids.map((id) => [id, { busy: db.prepare(`SELECT start_utc AS start, end_utc AS end FROM calendar_events e
    JOIN mailboxes m ON m.id = e.mailbox_id WHERE m.address = ? AND e.end_utc > ? AND e.start_utc < ?`).all(id, timeMin, timeMax) }])),
});
const calendarClientFor = () => devCalendar();

// Read cache rows (what step 6 sync would have stored). visibility private = someone's own business.
const cacheRow = db.prepare(`INSERT INTO calendar_events (business_id, mailbox_id, google_calendar_id, google_event_id, start_utc, end_utc, all_day, title, location, meet_url, visibility, status, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`);
const cached = (box, start, end, title, { location = null, meetUrl = null, allDay = 0, priv = false } = {}) => cacheRow.run(biz, mbx[box], `${box}@example.com`, `c${++gn}`, start, end, allDay, title, location, meetUrl, priv ? 'private' : 'default', new Date().toISOString());
cached('leo', J(9, 14), J(9, 15), '打ち合わせ みなと歯科（山本様）', { meetUrl: ZOOM });
cached('kit', J(10, 11), J(10, 12), '白波堂 打合せ', { location: '白波堂 本店' });
cached('leo', J(12, 12), J(12, 13), '歯医者', { priv: true });
cached('ada', J(12, 16), J(12, 17, 30), '私用', { priv: true });
cached('kit', J(12, 10), J(12, 11), '器屋 ロゴ確認', { meetUrl: MEET });
cached('kit', J(16, 10), J(16, 12), '私用', { priv: true });
cached('mia', J(23, 0), J(24, 0), '勤労感謝の日（休業）', { allDay: 1 });
cached('leo', J(25, 0), J(27, 0), '京都 撮影出張', { allDay: 1, location: '京都市' });
cached('mia', J(7, 16), J(7, 17), '社内 週次レビュー', { meetUrl: MEET });
cached('ada', J(5, 15), J(5, 16), 'しおさい荘 ご提案', { meetUrl: ZOOM });
cached('mia', J(4, 12), J(4, 13), '歯医者（非公開・自分の予定は全文表示）', { priv: true });
cached('kit', J(26, 11), J(26, 12), '白波堂 納品前確認', { location: '白波堂 本店' });
cached('ada', J(17, 9), J(17, 18), '私用', { priv: true });
cached('mia', J(17, 11), J(17, 11, 30), '町家ステイ 綾 写真受け取り確認');
cached('leo', J(2, 10), J(2, 11), '月初 数字の確認');
for (const box of ['leo', 'kit', 'mia', 'ada']) {
  db.prepare("INSERT INTO calendar_sync (business_id, mailbox_id, google_calendar_id, last_ok_at) VALUES (?, ?, ?, ?)").run(biz, mbx[box], `${box}@example.com`, new Date(Date.now() - 4 * 60_000).toISOString());
}
db.prepare("INSERT INTO calendar_sync (business_id, mailbox_id, google_calendar_id, last_ok_at) VALUES (?, NULL, 'hold@dev', ?)").run(biz, new Date(Date.now() - 4 * 60_000).toISOString());

// Suggestions (dates found in mail), holds on the 調整中 calendar, and confirmed meetings of our own.
const sug = (box, gt, { start, end = null, direction = 'theirs', kind = 'offer', state = 'suggested', who, statedTz = null, thread = true, msgAt = J(7, 9) }) => {
  const id = newId();
  db.prepare(`INSERT INTO suggestions (id, business_id, mailbox_id, thread_id, gmail_thread_id, gmail_message_id, direction, source, start_utc, end_utc, stated_tz, business_tz,
      counterpart_label, kind, state, message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, 'Asia/Tokyo', ?, ?, ?, ?, ?)`)
    .run(id, biz, mbx[box], thread ? tid(gt, box) : null, gt, `${gt}-${id.slice(0, 4)}`, direction, start, end, statedTz, who, kind, state, msgAt, msgAt);
  return id;
};
const hold = async (sid) => {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(sid); const id = newId();
  const ev = await devCalendar().insertEvent('hold@dev', { id: `h${id.slice(0, 8)}`, summary: `仮: ${s.counterpart_label}`, extendedProperties: { private: ourTag({ kind: 'hold', id, businessId: biz }) } });
  db.prepare("INSERT INTO holds (id, business_id, suggestion_id, google_calendar_id, google_event_id, etag, state, expires_at) VALUES (?, ?, ?, 'hold@dev', ?, ?, 'active', ?)")
    .run(id, biz, sid, ev.id, ev.etag, s.start_utc);
  db.prepare("UPDATE suggestions SET state = 'held' WHERE id = ?").run(sid);
};
await hold(sug('mia', 'GT0', { start: J(11, 10), direction: 'ours', who: '町家ステイ 綾', msgAt: J(6, 18) }));
await hold(sug('mia', 'GT0', { start: J(12, 15), direction: 'ours', who: '町家ステイ 綾', msgAt: J(6, 18) }));
sug('ada', 'GT1', { start: J(13, 10), who: '湯宿 ひなた' });
sug('ada', 'GT1', { start: J(14, 13), who: '湯宿 ひなた' });
await hold(sug('leo', 'GT-sent-19a7c', { start: J(19, 10), end: J(19, 11), direction: 'ours', who: '白波堂', thread: false, msgAt: J(5, 11) }));
await hold(sug('leo', 'GT-sent-19a7c', { start: J(19, 15), end: J(19, 16), direction: 'ours', who: '白波堂', thread: false, msgAt: J(5, 11) }));
sug('leo', 'GT2', { start: J(18, 16), who: '佐藤（こもれび）', msgAt: J(7, 8) });
sug('mia', 'GT3', { start: J(20, 13), end: J(20, 16), who: 'Emily Carter', statedTz: 'America/Los_Angeles' });
const meeting = async (box, gt, { start, end, title, place = null, link = null, change = null }) => {
  const id = newId(); const t = tid(gt, box);
  db.prepare(`INSERT INTO meetings (id, business_id, thread_id, mailbox_id, start_utc, end_utc, title, place, link_url, link_source, conference_status, confirmed_via, idem_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'console', ?)`).run(id, biz, t, mbx[box], start, end, title, place, link, link ? 'meet' : 'none', link ? 'ready' : 'none', `dev:${id}`);
  const ev = await devCalendar().insertEvent(`${box}@example.com`, { id: `m${id.slice(0, 8)}`, summary: title, extendedProperties: { private: ourTag({ kind: 'meeting', id, businessId: biz }) } });
  db.prepare('UPDATE meetings SET google_calendar_id = ?, google_event_id = ?, etag = ? WHERE id = ?').run(`${box}@example.com`, ev.id, ev.etag, id);
  if (change) db.prepare('UPDATE meetings SET pending_change_suggestion_id = ? WHERE id = ?').run(sug(box, gt, { start: change.start, end: change.end, kind: 'change', who: '器屋' }), id);
};
await meeting('kit', 'GT4', { start: J(14, 14), end: J(14, 15), title: '器屋 打ち合わせ', link: MEET, change: { start: J(16, 14), end: J(16, 15) } });
await meeting('mia', 'GT-acme', { start: J(12, 13), end: J(12, 14), title: 'Acme 定例（森田様）', link: MEET });
await meeting('mia', 'GT-cook', { start: J(21, 13), end: J(21, 16), title: 'Cooking class · Carter family (4)', place: '浅草 キッチンスタジオ' });

// 締切 (D54-D58): preview deadlines. Two confirmed (one from a date in the mail, one by the 3-day rule) and one
// AI suggestion waiting on its thread card (「プレビュー締切を設定」).
const dl = (box, gt, { due, source, who, address, confirmed = true, quote = null }) => db.prepare(`INSERT INTO deadlines (id, business_id, type, mailbox_id, thread_id,
    gmail_thread_id, gmail_message_id, client_label, client_address, due_date, source, quote_redacted, state, confirmed_at, message_at)
  VALUES (?, ?, 'preview', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(newId(), biz, mbx[box], tid(gt, box), gt, `${gt}-dl`, who, address, due, source, quote,
  confirmed ? J(7, 12) : null, J(7, 9));
dl('mia', 'GT0', { due: '2026-11-13', source: 'mail_date', who: '町家ステイ 綾', address: 'info@machiya.example', quote: '13日までにサンプルを拝見できますか' });
dl('leo', 'GT2', { due: '2026-11-10', source: 'rule', who: '佐藤（こもれび）', address: 'sato@komorebi.example' });
dl('ada', 'GT1', { due: '2026-11-11', source: 'rule', who: '湯宿 ひなた', address: 'yado@onsen.example', confirmed: false, quote: 'プレビューをぜひ見てみたいです' });

const app = buildApp({ db, config, ai, gmailFactory, websiteFetcher, calendarClientFor, meetWait: { wait: async () => {} }, exchange: async () => ({ id_token: idToken }) });
app.get('/dev', async (req, reply) => {
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  reply.header('set-cookie', `${cookie}; Path=/; HttpOnly; SameSite=Lax`).redirect('/');
});
// Sends (incl. 予約送信) go out locally: the reply is appended to the fake Gmail thread, nothing leaves.
const fakeTransport = { send: async ({ send, thread, mailbox }) => {
  const g = gmailThreads[thread.gmail_thread_id]; const id = `${thread.gmail_thread_id}-S${g.messages.length}`;
  g.messages.push({ id, threadId: g.id, internalDate: String(Date.now()), labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: mailbox.address }, { name: 'Subject', value: `Re: ${thread.cache_subject}` }, { name: 'Date', value: new Date().toUTCString() }],
    body: { data: Buffer.from(send.body_text).toString('base64url') } } });
  console.log(`[dev] sent ${send.id} → ${thread.cache_subject}`);
  return { messageId: id };
} };
setInterval(() => deliverDue(db, fakeTransport).then((r) => r.length && console.log('[dev] deliver', JSON.stringify(r))).catch((e) => console.error(e)), 2000);
// Simulate the customer writing again: GET /dev/reply?subject=<part of subject>
app.get('/dev/reply', async (req) => {
  const t = db.prepare('SELECT * FROM threads WHERE cache_subject LIKE ? LIMIT 1').get(`%${req.query.subject ?? ''}%`);
  if (!t) return { error: 'no thread' };
  const g = gmailThreads[t.gmail_thread_id]; const id = `${t.gmail_thread_id}-R${g.messages.length}`;
  g.messages.push({ id, threadId: g.id, internalDate: String(Date.now()), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: t.cache_from }, { name: 'Subject', value: `Re: ${t.cache_subject}` }, { name: 'Date', value: new Date().toUTCString() }],
    body: { data: Buffer.from('追加の質問です。やっぱり日程を変えてもいいですか？').toString('base64url') } } });
  db.prepare("UPDATE threads SET last_message_id = ?, status = 'new', last_message_at = ? WHERE id = ?").run(id, new Date().toISOString(), t.id);
  return { ok: true, thread: t.id };
});
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`console preview: http://127.0.0.1:${PORT}/dev`);
