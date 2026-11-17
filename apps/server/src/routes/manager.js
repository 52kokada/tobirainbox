// apps/server/src/routes/manager.js — Tobira Manager (Discord) endpoints, calendar plan step 18.
// D5/D12: the Manager writes confirmed meetings straight to Google through the inbox (calendar-writes via
// meetings.confirm). D17: its #カレンダー board reads this calendar. D31: the person chatting is the
// confirmer (confirmed_by_label, confirmed_via 'manager'). D32: Tobira only, behind the existing ADMIN_TOKEN;
// the business is fixed in config (MANAGER_BUSINESS_ID). The undo link posted to Discord carries a
// single-use, 7-day token (HMAC-SHA256 of 32 random bytes keyed by SECRETS_MASTER_KEY), never ADMIN_TOKEN.
// Dark while calendar_mode is 'off'; in 'shadow' calendar-writes sends every write to the shadow calendar.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { confirm, undo, MeetingError } from '../meetings.js';
import { CalendarWriteError } from '../calendar-writes.js';
import { eventsForViewer } from '../calendar-view.js';
import { openDeadlines, deadlineView, todayIn } from '../deadlines.js';
import { Store } from '../store.js';
import { gmailFor } from '../mailboxes.js';

const DAY = 86_400_000;
export const UNDO_TTL_MS = 7 * DAY; // plan §8.7
const MAX_RANGE_MS = 62 * DAY;
const STATUS = { not_found: 404, not_open: 409, past: 409, bad_time: 400, bad_mailbox: 400, bad_thread: 400, not_confirmed: 409 };

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
const bearer = (req) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || req.headers['x-admin-token'];
export const undoTokenHash = (token, masterKey) => createHmac('sha256', String(masterKey)).update(String(token)).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function registerManagerRoutes(app, { db, config, gmailFactory, clientFor, meetWait }) {
  const gmailOf = (mailbox) => gmailFor(mailbox, config, gmailFactory);
  const business = (reply) => {
    const b = config.managerBusinessId && db.prepare('SELECT * FROM businesses WHERE id = ?').get(config.managerBusinessId);
    if (!b || !b.calendar_mode || b.calendar_mode === 'off') { reply.code(404).send({ error: 'not found' }); return null; }
    return b;
  };
  const auth = (req, reply) => {
    if (!config.adminToken || !sameSecret(bearer(req), config.adminToken)) { reply.code(403).send({ error: 'forbidden' }); return null; }
    const asked = req.query?.business ?? req.body?.business;
    if (asked != null && String(asked) !== String(config.managerBusinessId)) { reply.code(403).send({ error: 'manager is Tobira only' }); return null; }
    return business(reply);
  };
  const fail = (reply, err) => {
    if (err instanceof MeetingError) return reply.code(STATUS[err.code] ?? 400).send({ error: err.code, message: err.message });
    if (err instanceof CalendarWriteError) return reply.code(409).send({ error: err.code, message: err.message });
    return reply.code(502).send({ error: 'calendar_error', message: String(err.message).slice(0, 300) });
  };
  const meetingOut = (m, mailboxes) => ({
    id: m.id, mailbox: mailboxes.get(m.mailbox_id) ?? null, start: m.start_utc, end: m.end_utc, title: m.title, place: m.place,
    link: m.link_url, conference: m.conference_status, state: m.state, via: m.confirmed_via, confirmedBy: m.confirmed_by_label ?? null,
  });
  const mailboxMap = (b) => new Map(db.prepare('SELECT id, address FROM mailboxes WHERE business_id = ?').all(b.id).map((r) => [r.id, r.address]));

  function issueUndo(meetingId, now = Date.now()) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO manager_undo_tokens (token_hash, meeting_id, expires_at) VALUES (?, ?, ?)')
      .run(undoTokenHash(token, config.masterKey), meetingId, new Date(now + UNDO_TTL_MS).toISOString());
    return `${config.publicUrl ?? ''}/m/undo/${token}`;
  }
  /** The unused, unexpired token row for this token, or null. */
  function tokenRow(token, now = new Date()) {
    if (!config.masterKey || !/^[A-Za-z0-9_-]{43}$/.test(String(token))) return null;
    const r = db.prepare('SELECT * FROM manager_undo_tokens WHERE token_hash = ?').get(undoTokenHash(token, config.masterKey));
    if (!r || r.used_at || Date.parse(r.expires_at) <= now.getTime()) return null;
    return r;
  }

  // D17: the board. Confirmed meetings + 調整中 holds and suggestions (+ other calendar events, private ones
  // busy-only because the Discord channel is shared), next 14 days unless from/to say otherwise.
  app.get('/api/manager/calendar', async (req, reply) => {
    const b = auth(req, reply); if (!b) return;
    const now = Date.now();
    const from = req.query?.from ? Date.parse(req.query.from) : now;
    const to = req.query?.to ? Date.parse(req.query.to) : from + 14 * DAY;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_RANGE_MS) return reply.code(400).send({ error: 'bad_range' });
    const f = new Date(from).toISOString(); const t = new Date(to).toISOString();
    const mailboxes = mailboxMap(b);
    const meetings = db.prepare("SELECT * FROM meetings WHERE business_id = ? AND state = 'confirmed' AND start_utc < ? AND end_utc > ? ORDER BY start_utc").all(b.id, t, f);
    const holds = db.prepare(`SELECT h.id, h.state, s.id AS suggestion_id, s.mailbox_id, s.start_utc, s.end_utc, s.counterpart_label, s.direction
        FROM holds h JOIN suggestions s ON s.id = h.suggestion_id
        WHERE h.business_id = ? AND h.state IN ('active','flagged') AND s.start_utc < ? AND s.start_utc >= ? ORDER BY s.start_utc`).all(b.id, t, f);
    const suggestions = db.prepare(`SELECT id, mailbox_id, start_utc, end_utc, counterpart_label, direction, kind FROM suggestions
        WHERE business_id = ? AND state = 'suggested' AND start_utc < ? AND start_utc >= ? ORDER BY start_utc`).all(b.id, t, f);
    const skip = new Set([b.hold_calendar_id, b.shadow_calendar_id].filter(Boolean));
    const events = eventsForViewer(db.prepare(`SELECT * FROM calendar_events WHERE business_id = ? AND start_utc < ? AND end_utc > ?
        AND (status IS NULL OR status != 'cancelled') AND ours_tag IS NULL ORDER BY start_utc`).all(b.id, t, f)
      .filter((e) => !skip.has(e.google_calendar_id)), { ownMailboxId: null });
    // 締切 (D56): confirmed, open deadlines due before `to`, overdue ones included until someone closes them.
    const tz = b.timezone || 'Asia/Tokyo'; const today = todayIn(tz, new Date(now));
    const lastDay = todayIn(tz, new Date(to - 1));
    const deadlines = openDeadlines(db, b.id, { toDate: lastDay }).map((d) => {
      const v = deadlineView(d, tz, today);
      return { id: v.id, type: v.type, mailbox: mailboxes.get(d.mailbox_id) ?? null, due: v.due, start: v.start, end: v.end, allDay: true, who: v.client, source: v.source, overdue: v.overdue, threadId: v.threadId };
    });
    return {
      mode: b.calendar_mode, timezone: tz, from: f, to: t, deadlines,
      meetings: meetings.map((m) => meetingOut(m, mailboxes)),
      holds: holds.map((h) => ({ id: h.id, state: h.state, suggestionId: h.suggestion_id, mailbox: mailboxes.get(h.mailbox_id) ?? null, start: h.start_utc, end: h.end_utc, who: h.counterpart_label, direction: h.direction })),
      suggestions: suggestions.map((s) => ({ id: s.id, mailbox: mailboxes.get(s.mailbox_id) ?? null, start: s.start_utc, end: s.end_utc, who: s.counterpart_label, direction: s.direction, kind: s.kind })),
      events: events.map((e) => ({ mailbox: mailboxes.get(e.mailbox_id) ?? null, start: e.start_utc, end: e.end_utc, allDay: Boolean(e.all_day), busy: e.busy, title: e.title ?? null, location: e.location ?? null, link: e.meet_url ?? null })),
    };
  });

  // D12 + D31: a chat addition. Body: { confirmer, mailbox (address or id), start, end?, title?, place?, idemKey? }.
  app.post('/api/manager/meetings', async (req, reply) => {
    const b = auth(req, reply); if (!b) return;
    const body = req.body ?? {};
    const confirmer = String(body.confirmer ?? '').trim().slice(0, 100);
    if (!confirmer) return reply.code(400).send({ error: 'confirmer_required' });
    const want = String(body.mailbox ?? '').trim().toLowerCase();
    const mb = db.prepare('SELECT id FROM mailboxes WHERE business_id = ? AND (id = ? OR lower(address) = ?)').get(b.id, String(body.mailbox ?? ''), want);
    if (!mb) return reply.code(400).send({ error: 'bad_mailbox' });
    const idemKey = body.idemKey ? `manager:${String(body.idemKey).slice(0, 180)}` : undefined;
    try {
      const r = await confirm({ db, config, ai: null, gmailFor: gmailOf, clientFor, businessId: b.id, user: { id: null }, meetWait,
        input: { mailboxId: mb.id, start: body.start, end: body.end, title: body.title, place: body.place }, idemKey });
      if (r.created) {
        db.prepare("UPDATE meetings SET confirmed_via = 'manager', confirmed_by_user_id = NULL, confirmed_by_label = ? WHERE id = ?").run(confirmer, r.meeting.id);
        new Store(db, b.id).audit(null, 'manager_meeting_confirmed', r.meeting.id, { confirmer });
      }
      const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(r.meeting.id);
      // A repeat of the same idemKey gets a fresh link; older links stay valid until used or expired.
      return reply.code(r.created ? 201 : 200).send({ meeting: meetingOut(m, mailboxMap(b)), created: r.created, undoUrl: issueUndo(m.id) });
    } catch (err) { return fail(reply, err); }
  });

  async function undoMeeting(b, meetingId, actor) {
    const r = await undo({ db, config, ai: null, gmailFor: gmailOf, clientFor, businessId: b.id, user: { id: null }, meetingId });
    new Store(db, b.id).audit(null, 'manager_meeting_undone', meetingId, { by: actor });
    return r.meeting;
  }

  app.post('/api/manager/meetings/:id/undo', async (req, reply) => {
    const b = auth(req, reply); if (!b) return;
    const m = db.prepare('SELECT * FROM meetings WHERE id = ? AND business_id = ?').get(req.params.id, b.id);
    if (!m) return reply.code(404).send({ error: 'not found' });
    try {
      const done = await undoMeeting(b, m.id, String(req.body?.confirmer ?? 'manager').slice(0, 100));
      return { meeting: meetingOut(done, mailboxMap(b)) };
    } catch (err) { return fail(reply, err); }
  });

  // The Discord link opens a confirm page; only its POST undoes, so link previews never spend the token.
  const page = (reply, code, title, inner) => reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}button{font:inherit;padding:.6rem 1.2rem;border:1px solid #111;background:#111;color:#fff;border-radius:6px;cursor:pointer}</style></head>
<body><h1>${esc(title)}</h1>${inner}</body></html>`);
  const gone = (reply) => page(reply, 410, 'このリンクは使えません', '<p>取り消しリンクは使用済みか、期限（7日）が切れています。</p>');

  app.get('/m/undo/:token', async (req, reply) => {
    const b = business(reply); if (!b) return;
    const r = tokenRow(req.params.token); if (!r) return gone(reply);
    const m = db.prepare('SELECT * FROM meetings WHERE id = ? AND business_id = ?').get(r.meeting_id, b.id); if (!m) return gone(reply);
    const tz = b.timezone || 'Asia/Tokyo';
    const when = new Intl.DateTimeFormat('ja-JP', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(m.start_utc));
    if (m.state !== 'confirmed') return page(reply, 200, 'すでに取り消し済みです', `<p>${esc(m.title)}（${esc(when)}）は確定状態ではありません。</p>`);
    return page(reply, 200, '確定を取り消しますか', `<p>${esc(m.title)}<br>${esc(when)}${m.confirmed_by_label ? `<br>確定: ${esc(m.confirmed_by_label)}` : ''}</p>
<form method="post" action="/m/undo/${esc(req.params.token)}"><input type="hidden" name="meeting" value="${esc(m.id)}"><button type="submit">取り消す</button></form>`);
  });

  app.post('/m/undo/:token', async (req, reply) => {
    const b = business(reply); if (!b) return;
    const r = tokenRow(req.params.token); if (!r) return gone(reply);
    if (req.body?.meeting != null && String(req.body.meeting) !== r.meeting_id) return gone(reply);
    // Spend the token first so two clicks cannot both undo; give it back if the undo itself fails.
    const spent = db.prepare("UPDATE manager_undo_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ? AND used_at IS NULL").run(r.token_hash);
    if (spent.changes !== 1) return gone(reply);
    try {
      await undoMeeting(b, r.meeting_id, 'undo-link');
      return page(reply, 200, '取り消しました', '<p>カレンダーの予定を削除しました。</p>');
    } catch (err) {
      db.prepare('UPDATE manager_undo_tokens SET used_at = NULL WHERE token_hash = ?').run(r.token_hash);
      return page(reply, 502, '取り消せませんでした', `<p>${esc(String(err.message).slice(0, 200))}</p><p>時間をおいてもう一度お試しください。</p>`);
    }
  });
}
