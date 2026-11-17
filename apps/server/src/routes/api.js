// apps/server/src/routes/api.js — console API. Every route resolves the business
// from the signed-in session; a request can never name another business.
import { findBlanks, parseFrom, stripQuotedContent } from '@tobira-inbox/engine';
import { Store, newId } from '../store.js';
import { currentSession } from '../auth.js';
import { parseMessage } from '../gmail.js';
import { gmailFor, relabelThread } from '../mailboxes.js';
import { draftWithRetry, draftFollowup } from '../drafting.js';
import { recordOutcome } from '../outreach.js';
import { closeCopies } from '../copies.js';
import { queueSend, cancelSend, rescheduleSend, SendRefused } from '../send-queue.js';
import { openAlerts } from '../alerts.js';
import { closeIfAnswered } from '../answered.js';
import { ingestMailbox } from '../ingest.js';
import { threadLinks } from '../links.js';
import { ownMatcher } from '../ingest.js';
import { accessScope, mailboxFilter, canSee, canSendFrom, threadIdFor } from '../partner.js';
import { calendarVisibleFor, threadScheduling } from '../calendar-board.js';
import { threadDeadline } from '../deadlines.js';
import { meetingLinkForThread } from '../meeting-links.js';

// 要対応 = mail that needs a reply (the company's auto-draft labels); everything else
// that is still open is under 受信. Built per request from the company's own labels.
const VIEW_NAMES = ['todo', 'unconfirmed', 'inbox', 'scheduled', 'sent', 'done', 'all', 'noise', 'outreach', 'followup'];
// 営業の返信 / フォローアップ: threads CRM stamped (outreach.js). A reply sent or scheduled here since the
// last stamp takes the thread off the list at once, without waiting for the next sync.
const SENT_SINCE_STAMP = `EXISTS (SELECT 1 FROM sends s JOIN drafts d ON d.id = s.draft_id WHERE d.thread_id = t.id
  AND s.status IN ('queued','sending','sent') AND s.queued_at > COALESCE(t.outreach_synced_at, ''))`;
export const OUTREACH_ORDER = { outreach: 't.outreach_positive_reply_at ASC, t.last_message_at ASC', followup: 't.outreach_days_quiet DESC, t.last_message_at ASC' };
// 予約送信: a reply is waiting for its time. It leaves 要対応 / 要確認 / 受信 and shows under 予約.
// Copies of the same email in other mailboxes (CC) count too: the reply is handled once, from one of them.
const SCHEDULED_SQL = `EXISTS (SELECT 1 FROM sends s JOIN drafts d ON d.id = s.draft_id JOIN threads t2 ON t2.id = d.thread_id
  WHERE s.status = 'queued' AND s.scheduled_at IS NOT NULL AND t2.business_id = t.business_id
    AND (t2.id = t.id OR (t.last_rfc_message_id IS NOT NULL AND t2.last_rfc_message_id = t.last_rfc_message_id)))`;
// Machine mail that never belongs in the conversation history: newsletters, auto-replies, DMARC reports,
// security alerts, notifications. It stays findable under お知らせ・自動; archived/trashed mail ('ignored') is hidden.
const NOISE_SENDER = ['no-reply', 'noreply', 'do-not-reply', 'donotreply', 'dmarc', 'notification', 'notify', 'postmaster', 'mailer-daemon',
  'newsletter', 'mailmagazine', 'news@', '@updates.', '@marketing.', 'alerts@', 'digest@'];
export const NOISE_SQL = `(t.label_key IN ('notice','auto_reply','spam') OR ${NOISE_SENDER.map((p) => `INSTR(LOWER(t.cache_from), '${p}') > 0`).join(' OR ')})`;
export function viewSql(view, replyKeys) {
  const keys = replyKeys.length ? replyKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(',') : "''";
  switch (view) {
    case 'todo': return `t.status IN ('new','drafted') AND t.label_key IN (${keys}) AND NOT ${SCHEDULED_SQL}`;
    // Only open mail: old conversations from the history backfill (送信済み / 完了) never count as waiting.
    case 'unconfirmed': return `t.label_key = 'unconfirmed' AND t.status IN ('new','drafted') AND NOT ${NOISE_SQL} AND NOT ${SCHEDULED_SQL}`;
    case 'inbox': return `t.status IN ('new','drafted') AND t.label_key NOT IN (${keys}) AND t.label_key != 'unconfirmed' AND NOT ${SCHEDULED_SQL}`;
    case 'scheduled': return SCHEDULED_SQL;
    case 'sent': return `t.status IN ('sent','waiting') AND NOT ${NOISE_SQL}`;
    case 'done': return `t.status = 'done' AND NOT ${NOISE_SQL}`;
    case 'noise': return `t.status != 'ignored' AND ${NOISE_SQL}`;
    case 'outreach': return `t.outreach_bucket = 'unanswered_positive' AND t.status != 'ignored' AND NOT ${SENT_SINCE_STAMP}`;
    case 'followup': return `t.outreach_bucket = 'gone_quiet' AND t.status != 'ignored' AND NOT ${SENT_SINCE_STAMP}`;
    default: return `t.status != 'ignored' AND NOT ${NOISE_SQL}`;
  }
}

export function registerApiRoutes(app, { db, config, ai, gmailFactory }) {
  const auth = (req, reply) => {
    const s = currentSession(db, req, config.masterKey);
    if (!s) { reply.code(401).send({ error: 'sign in required' }); return null; }
    // D8 partner: only the mailboxes an owner granted. Anything outside them is "not found".
    const scope = accessScope(db, s.user);
    if (scope && req.params?.id) {
      const tid = threadIdFor(db, s.business.id, req.url, req.params.id);
      if (tid != null) {
        const mb = tid && db.prepare('SELECT mailbox_id FROM threads WHERE id = ? AND business_id = ?').get(tid, s.business.id)?.mailbox_id;
        if (!mb || !canSee(scope, mb)) { reply.code(404).send({ error: 'not found' }); return null; }
      }
    }
    return { ...s, scope, store: new Store(db, s.business.id) };
  };
  const draftView = (d) => d && ({
    id: d.id, version: d.version, body: d.body_text, status: d.status, model: d.model,
    createdBy: d.created_by, blanks: findBlanks(d.body_text).map((b) => b.text), createdAt: d.created_at,
  });

  app.get('/api/me', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    return {
      user: { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role, locale: s.user.locale ?? s.business.locale },
      business: {
        name: s.business.name, undoSeconds: s.business.undo_seconds, plainText: Boolean(s.business.plain_text),
        dailyCapUsd: s.business.ai_daily_cap_usd ?? config.aiDailyCapUsd,
      },
      // D8: every business this person belongs to (same email), with their role in each.
      businesses: db.prepare(`SELECT b.id, b.name, u.role FROM users u JOIN businesses b ON b.id = u.business_id
          WHERE LOWER(u.email) = LOWER(?) AND b.status = 'active' ORDER BY b.name`).all(s.user.email).map((b) => ({ ...b, current: b.id === s.business.id })),
      mailboxes: s.store.mailboxes().filter((m) => canSee(s.scope, m.id)).map((m) => ({ id: m.id, address: m.address, mode: m.mode, status: m.status, lastPolledAt: m.last_polled_at,
        canSend: canSendFrom(s.scope, m.id) })),
      labels: s.store.labels().filter((l) => !l.hidden).map((l) => ({ key: l.key, ja: l.ja, en: l.en, autoDraft: l.autoDraft })),
      // Calendar tab gate (D45): the console shows it when mode is on, or in shadow for owners (calendarVisibleFor).
      calendar: { mode: s.business.calendar_mode ?? 'off', timezone: s.business.timezone ?? 'Asia/Tokyo', visible: calendarVisibleFor(s.business.calendar_mode, s.user) },
    };
  });

  app.get('/api/threads', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const view = VIEW_NAMES.includes(req.query?.view) ? req.query.view : 'todo';
    const replyKeys = s.store.labels().filter((l) => l.autoDraft).map((l) => l.key);
    const scoped = mailboxFilter(s.scope);
    const args = [s.business.id, ...scoped.args];
    let where = `t.business_id = ? AND ${viewSql(view, replyKeys)}${scoped.sql}`;
    if (req.query?.mailbox) { where += ' AND t.mailbox_id = ?'; args.push(req.query.mailbox); }
    if (req.query?.label) { where += ' AND t.label_key = ?'; args.push(req.query.label); }
    if (req.query?.q) {
      const like = `%${String(req.query.q).slice(0, 80).replace(/[!%_]/g, (c) => `!${c}`)}%`;
      where += " AND (t.cache_from LIKE ? ESCAPE '!' OR t.cache_subject LIKE ? ESCAPE '!' OR t.cache_snippet LIKE ? ESCAPE '!')"; args.push(like, like, like);
    }
    const rows = db.prepare(`SELECT t.*, m.address,
        (SELECT d.body_text FROM drafts d WHERE d.thread_id = t.id AND d.status != 'discarded' ORDER BY d.version DESC LIMIT 1) AS draft_body,
        u.email AS assignee_email,
        (SELECT s.scheduled_at FROM sends s JOIN drafts d ON d.id = s.draft_id WHERE d.thread_id = t.id AND s.status = 'queued' AND s.scheduled_at IS NOT NULL LIMIT 1) AS scheduled_at
      FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id LEFT JOIN users u ON u.id = t.assignee_user_id
      WHERE ${where} ORDER BY ${view === 'scheduled' ? 'scheduled_at ASC' : OUTREACH_ORDER[view] ?? 't.last_message_at DESC'} LIMIT ${view === 'all' ? 1000 : 200}`).all(...args);
    const counts = Object.fromEntries(VIEW_NAMES.map((v) => [v,
      db.prepare(`SELECT COUNT(DISTINCT COALESCE(t.last_rfc_message_id, t.id)) AS n FROM threads t WHERE t.business_id = ? AND ${viewSql(v, replyKeys)}${scoped.sql}`).get(s.business.id, ...scoped.args).n]));
    // Outreach leads with no thread in Inbox (their mailbox may not be connected): listed under the same tabs.
    const leads = s.scope ? [] : db.prepare('SELECT * FROM outreach_leads WHERE business_id = ? ORDER BY positive_reply_at, days_quiet DESC').all(s.business.id);
    for (const l of leads) counts[l.bucket === 'unanswered_positive' ? 'outreach' : 'followup'] += 1;
    // One email that reached several of our mailboxes (CC to two of us) is one row; the others ride along.
    const groups = new Map();
    for (const t of rows) {
      const key = t.last_rfc_message_id || t.id;
      const g = groups.get(key);
      if (!g) groups.set(key, { main: t, also: [] });
      else if (!g.main.draft_body && t.draft_body) { g.also.push(g.main); g.main = t; } else g.also.push(t);
    }
    return {
      view, counts,
      leads: ['outreach', 'followup'].includes(view) ? leads.filter((l) => (l.bucket === 'unanswered_positive') === (view === 'outreach')).map((l) => ({
        leadId: l.lead_id, company: l.company_name, email: l.contact_email, bucket: l.bucket, positiveReplyAt: l.positive_reply_at,
        lastActivityAt: l.last_activity_at, daysQuiet: l.days_quiet, draft: l.draft_body ? { subject: l.draft_subject, body: l.draft_body } : null,
      })) : [],
      threads: [...groups.values()].map(({ main: t, also }) => ({
        id: t.id, mailbox: t.address, alsoTo: also.map((x) => x.address),
        copies: also.map((x) => ({ id: x.id, mailbox: x.address, status: x.status, hasDraft: Boolean(x.draft_body), blanks: x.draft_body ? findBlanks(x.draft_body).length : 0 })), label: t.label_key, labelBy: t.label_by, labelGuess: t.label_guess, confidence: t.label_confidence,
        status: t.status, from: t.cache_from, subject: t.cache_subject, snippet: t.cache_snippet, at: t.last_message_at,
        inSpam: Boolean(t.in_spam), hasDraft: Boolean(t.draft_body), blanks: t.draft_body ? findBlanks(t.draft_body).length : 0, assignee: t.assignee_email,
        scheduledAt: t.scheduled_at ?? null,
        outreach: t.outreach_bucket ? { bucket: t.outreach_bucket, daysQuiet: t.outreach_days_quiet, positiveReplyAt: t.outreach_positive_reply_at } : null,
      })),
    };
  });

  app.get('/api/threads/:id', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const t = s.store.thread(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const mbx = s.store.mailbox(t.mailbox_id);
    let messages = [];
    try {
      const raw = await gmailFor(mbx, config, gmailFactory).getThread(t.gmail_thread_id);
      if (closeIfAnswered(db, t, raw.messages)) { closeCopies(db, t.id, 'done'); t.status = 'done'; }
      const own = mbx.address.toLowerCase();
      messages = (raw.messages ?? []).map(parseMessage).filter((m) => !m.reaction).map((m) => ({
        id: m.id, from: m.from, to: m.to, subject: m.subject, date: m.date || m.internalDate, fromUs: parseFrom(m.from) === own, files: m.attachments,
        body: stripQuotedContent(m.body), full: m.body, hasQuote: stripQuotedContent(m.body).length < m.body.trim().length,
      }));
    } catch (err) {
      messages = [{ id: 'error', from: '', body: `メールを読み込めませんでした: ${err.message}`, fromUs: false }];
    }
    const links = threadLinks(messages.filter((m) => m.id !== 'error'), { isOwn: ownMatcher(db, s.business.id) });
    const outgoing = db.prepare('SELECT id, filename, mime, size FROM thread_attachments WHERE thread_id = ? AND sent_at IS NULL ORDER BY created_at').all(t.id);
    const pending = db.prepare("SELECT s.id, s.undo_until, s.scheduled_at, s.body_text FROM sends s JOIN drafts d ON d.id = s.draft_id WHERE d.thread_id = ? AND s.status = 'queued' AND s.business_id = ?")
      .get(t.id, s.business.id);
    return {
      thread: { id: t.id, mailbox: mbx.address, mailboxMode: mbx.mode, canSend: canSendFrom(s.scope, t.mailbox_id), label: t.label_key, labelBy: t.label_by, labelGuess: t.label_guess, status: t.status, subject: t.cache_subject, inSpam: Boolean(t.in_spam),
        outreach: t.cockpit_lead_id ? { leadId: t.cockpit_lead_id, bucket: t.outreach_bucket, daysQuiet: t.outreach_days_quiet, positiveReplyAt: t.outreach_positive_reply_at,
          outcome: t.outreach_outcome, outcomeAt: t.outreach_outcome_at } : null },
      messages,
      draft: draftView(s.store.latestDraft(t.id)),
      pendingSend: pending ? { id: pending.id, undoUntil: pending.undo_until, scheduledAt: pending.scheduled_at, body: pending.scheduled_at ? pending.body_text : undefined } : null,
      links, outgoing,
      // Step 16 thread card: only where the calendar is visible to this viewer (D45); the thread is already in scope.
      scheduling: calendarVisibleFor(s.business.calendar_mode, s.user)
        ? threadScheduling(db, { business: s.business, thread: t, mailLink: meetingLinkForThread(messages.filter((m) => m.id !== 'error'))?.url ?? null }) : null,
      // D54: the preview deadline suggestion (or the confirmed deadline) for this thread, same visibility.
      deadline: calendarVisibleFor(s.business.calendar_mode, s.user) ? threadDeadline(db, { business: s.business, thread: t }) : null,
    };
  });

  app.post('/api/threads/:id/label', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const r = await relabelThread({ db, config, threadId: req.params.id, businessId: s.business.id, to: String(req.body?.label ?? ''), userId: s.user.id, gmailFactory });
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { ok: true };
  });

  app.post('/api/threads/:id/status', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const status = String(req.body?.status ?? '');
    if (!['done', 'ignored', 'new'].includes(status)) return reply.code(400).send({ error: 'bad status' });
    const r = db.prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ? AND business_id = ?').run(status, new Date().toISOString(), req.params.id, s.business.id);
    if (!r.changes) return reply.code(404).send({ error: 'not found' });
    closeCopies(db, req.params.id, status);
    s.store.audit(s.user.id, `status_${status}`, req.params.id);
    return { ok: true };
  });

  // 迷惑メールではない: move it to the inbox in Gmail too (Gmail learns the sender).
  // 更新: check every mailbox now (same work as the worker's pass), for when the regular sync lags.
  const syncing = new Map();
  app.post('/api/sync', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const last = syncing.get(s.business.id);
    if (last?.running) return { ok: true, running: true };
    if (last && Date.now() - last.at < 20_000) return { ok: true, recent: true };
    syncing.set(s.business.id, { running: true, at: Date.now() });
    const out = { checked: 0, sorted: 0, errors: [] };
    try {
      for (const m of db.prepare("SELECT * FROM mailboxes WHERE business_id = ? AND status = 'connected' AND mode != 'paused'").all(s.business.id).filter((x) => canSee(s.scope, x.id))) {
        try { const r = await ingestMailbox({ db, mailbox: m, ai, config, gmailFactory }); out.checked += r.checked; out.sorted += r.sorted; }
        catch (err) { out.errors.push({ mailbox: m.address, error: String(err.message).slice(0, 200) }); }
      }
    } finally { syncing.set(s.business.id, { running: false, at: Date.now() }); }
    return { ok: true, ...out };
  });

  // Files: attach to the reply (up to 10 MB per reply), remove, and open a customer's attachment from Gmail.
  const MAX_REPLY_BYTES = 10 * 1024 * 1024;
  app.post('/api/threads/:id/attachments', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const t = s.store.thread(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const filename = String(req.body?.filename ?? '').replace(/[\\/\r\n]/g, '_').slice(0, 200) || 'file';
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(req.body?.mimeType ?? '')) ? req.body.mimeType : 'application/octet-stream';
    const data = Buffer.from(String(req.body?.data ?? ''), 'base64');
    if (!data.length) return reply.code(400).send({ error: 'empty file' });
    const used = db.prepare('SELECT COALESCE(SUM(size), 0) n FROM thread_attachments WHERE thread_id = ? AND sent_at IS NULL').get(t.id).n;
    if (used + data.length > MAX_REPLY_BYTES) return reply.code(413).send({ error: 'too_large', message: '1 通に添付できるのは合計 10 MB までです' });
    const id = newId();
    db.prepare('INSERT INTO thread_attachments (id, business_id, thread_id, filename, mime, size, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, s.business.id, t.id, filename, mime, data.length, data);
    return { file: { id, filename, mime, size: data.length } };
  });
  app.delete('/api/threads/:id/attachments/:fid', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    db.prepare('DELETE FROM thread_attachments WHERE id = ? AND thread_id = ? AND business_id = ? AND sent_at IS NULL').run(req.params.fid, req.params.id, s.business.id);
    return { ok: true };
  });
  app.get('/api/threads/:id/files/:mid/:aid', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const t = s.store.thread(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const g = gmailFor(s.store.mailbox(t.mailbox_id), config, gmailFactory);
    try {
      const msg = parseMessage(await g.getMessage(req.params.mid));
      if (msg.threadId && msg.threadId !== t.gmail_thread_id) return reply.code(404).send({ error: 'not found' });
      // Gmail hands out a new attachment id on every fetch, so the link names the file by its position
      // in the message (stable); a stored id still works when Gmail happens to return the same one.
      const list = msg.attachments ?? [];
      const f = /^\d{1,3}$/.test(req.params.aid) ? list[Number(req.params.aid)] : list.find((x) => x.id === req.params.aid);
      if (!f) return reply.code(404).send({ error: 'not found' });
      const a = await g.call('GET', `/messages/${req.params.mid}/attachments/${f.id}`);
      const buf = Buffer.from(String(a.data ?? ''), 'base64url');
      const inline = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i.test(f.mimeType);
      return reply.header('content-type', inline ? f.mimeType : 'application/octet-stream')
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
        .header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=300').send(buf);
    } catch (err) { return reply.code(502).send({ error: 'gmail', message: err.message }); }
  });

  app.get('/api/alerts', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    return { alerts: s.scope ? [] : openAlerts(db, s.business.id) };
  });
  app.post('/api/alerts/:id/dismiss', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    if (s.scope) return reply.code(403).send({ error: 'not for partners' });
    db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND business_id = ? AND resolved_at IS NULL').run(new Date().toISOString(), req.params.id, s.business.id);
    return { ok: true };
  });

  // アーカイブ / ゴミ箱: off the screen here and in Gmail; undo puts it back.
  app.post('/api/threads/:id/archive', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const t = s.store.thread(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const trash = Boolean(req.body?.trash); const undo = Boolean(req.body?.undo);
    const g = gmailFor(s.store.mailbox(t.mailbox_id), config, gmailFactory);
    try {
      if (undo) { if (t.status === 'ignored') { await g.call('POST', `/threads/${t.gmail_thread_id}/untrash`).catch(() => {}); await g.modifyThread(t.gmail_thread_id, { add: ['INBOX'], remove: [] }); } }
      else if (trash) await g.call('POST', `/threads/${t.gmail_thread_id}/trash`);
      else await g.modifyThread(t.gmail_thread_id, { add: [], remove: ['INBOX'] });
    } catch (err) { return reply.code(502).send({ error: 'gmail', message: err.message }); }
    const prev = req.body?.prevStatus && ['new', 'drafted', 'sent', 'done', 'waiting'].includes(req.body.prevStatus) ? req.body.prevStatus : 'done';
    db.prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?').run(undo ? prev : 'ignored', new Date().toISOString(), t.id);
    if (!undo) closeCopies(db, t.id, 'ignored');
    s.store.audit(s.user.id, undo ? 'unarchive' : trash ? 'trash' : 'archive', t.id);
    return { ok: true, prevStatus: t.status };
  });

  app.post('/api/threads/:id/not-spam', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const t = s.store.thread(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    try { await gmailFor(s.store.mailbox(t.mailbox_id), config, gmailFactory).modifyThread(t.gmail_thread_id, { add: ['INBOX'], remove: ['SPAM'] }); }
    catch (err) { return reply.code(502).send({ error: 'gmail', message: err.message }); }
    db.prepare('UPDATE threads SET in_spam = 0 WHERE id = ?').run(t.id);
    s.store.audit(s.user.id, 'not_spam', t.id);
    return { ok: true };
  });

  app.post('/api/threads/:id/claim', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const r = db.prepare('UPDATE threads SET assignee_user_id = ? WHERE id = ? AND business_id = ?').run(req.body?.release ? null : s.user.id, req.params.id, s.business.id);
    if (!r.changes) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // Draft on request (D14): for labels that are not auto-drafted, or to try again.
  app.post('/api/threads/:id/draft', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const t = s.store.thread(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    if (!ai) return reply.code(503).send({ error: 'AI not configured' });
    const mbx = s.store.mailbox(t.mailbox_id);
    const gmail = gmailFor(mbx, config, gmailFactory);
    // フォローアップ: our side wrote last (the lead went quiet). Refused when the customer wrote last.
    if (req.body?.mode === 'followup') {
      const run = (onText) => draftFollowup({ db, mailbox: mbx, gmail, ai, thread: t, config, isOwn: ownMatcher(db, s.business.id), onText });
      const why = (r) => (r.reason === 'they wrote last' ? 'お客様からのメールが最新です。通常の返信を作成してください' : r.reason);
      if (req.query?.stream === '1') {
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
        const send = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}

`); };
        send({ t: 'start' });
        try {
          const r = await run((d) => send({ t: 'd', v: d }));
          if (r.status !== 'drafted') send({ t: 'error', error: why(r) }); else send({ t: 'done', draft: draftView(s.store.latestDraft(t.id)) });
        } catch (err) { send({ t: 'error', error: `下書きを作成できませんでした: ${err.message}` }); }
        res.end();
        return reply;
      }
      try {
        const r = await run();
        if (r.status !== 'drafted') return reply.code(r.reason === 'they wrote last' ? 400 : 409).send({ error: r.reason, message: why(r) });
      } catch (err) { return reply.code(502).send({ error: `下書きを作成できませんでした: ${err.message}` }); }
      return { draft: draftView(s.store.latestDraft(t.id)) };
    }
    const raw = await gmail.getThread(t.gmail_thread_id);
    const own = mbx.address.toLowerCase();
    const last = (raw.messages ?? []).map(parseMessage).reverse().find((m) => !m.reaction && parseFrom(m.from) !== own);
    if (!last) return reply.code(400).send({ error: 'no inbound message' });
    // A fresh request replaces an existing draft for the same message.
    // Keep the person's unsaved edits as their own version before the AI rewrites, so nothing is lost.
    const prior = s.store.latestDraft(t.id);
    if (req.body?.current && prior && String(req.body.current) !== prior.body_text) {
      const body = String(req.body.current).slice(0, 20000);
      s.store.saveDraft({ threadId: t.id, bodyText: body, blanks: findBlanks(body).map((b) => b.text), createdBy: 'user', note: '手直し' });
    }
    db.prepare("UPDATE drafts SET status = 'discarded' WHERE thread_id = ? AND status = 'open'").run(t.id);
    db.prepare('UPDATE drafts SET for_message_id = NULL WHERE thread_id = ? AND for_message_id = ?').run(t.id, last.id);
    db.prepare('DELETE FROM draft_attempts WHERE thread_id = ? AND message_id = ?').run(t.id, last.id);
    // A rewrite request (console chips / free text) carries the person's instruction and the current text.
    const instruction = req.body?.instruction ? String(req.body.instruction).slice(0, 300) : undefined;
    const current = instruction ? String(req.body?.current ?? '').slice(0, 6000) : undefined;
    if (req.query?.stream === '1') {
      // Live view: the text arrives as the model writes it, then the stored draft.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
      const send = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
      send({ t: 'start' });
      try {
        const r = await draftWithRetry({ db, mailbox: mbx, gmail, ai, threadId: t.id, msg: last, config, force: true, instruction, current, onText: (d) => send({ t: 'd', v: d }) });
        if (r.status !== 'drafted') send({ t: 'error', error: r.reason });
        else send({ t: 'done', draft: draftView(s.store.latestDraft(t.id)) });
      } catch (err) {
        send({ t: 'error', error: `下書きを作れませんでした（自動で再試行します）: ${err.message}` });
      }
      res.end();
      return reply;
    }
    try {
      const r = await draftWithRetry({ db, mailbox: mbx, gmail, ai, threadId: t.id, msg: last, config, force: true, instruction, current });
      if (r.status !== 'drafted') return reply.code(409).send({ error: r.reason });
    } catch (err) {
      return reply.code(502).send({ error: `下書きを作れませんでした（自動で再試行します）: ${err.message}` });
    }
    return { draft: draftView(s.store.latestDraft(t.id)) };
  });

  // Outreach outcome (打ち合わせ確定 / 提案送付 / 受注 / 失注): stored on the thread and sent to CRM via the outbox.
  app.post('/api/threads/:id/outcome', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const r = recordOutcome(db, { businessId: s.business.id, threadId: req.params.id, outcome: String(req.body?.outcome ?? ''), userId: s.user.id });
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return r;
  });

  // Every version of the reply (AI rewrites and the person's edits), newest first.
  app.get('/api/threads/:id/versions', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    if (!s.store.thread(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const rows = db.prepare('SELECT id, version, created_by, note, status, created_at, body_text FROM drafts WHERE thread_id = ? AND business_id = ? ORDER BY version DESC LIMIT 30')
      .all(req.params.id, s.business.id);
    return { versions: rows.map((r) => ({ id: r.id, version: r.version, by: r.created_by, note: r.note, status: r.status, at: r.created_at, body: r.body_text })) };
  });

  app.put('/api/drafts/:id', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const d = s.store.draft(req.params.id);
    if (!d) return reply.code(404).send({ error: 'not found' });
    const body = String(req.body?.body ?? '');
    if (body === d.body_text) return { draft: draftView(d) };
    const id = s.store.saveDraft({ threadId: d.thread_id, bodyText: body, blanks: findBlanks(body).map((b) => b.text), createdBy: 'user' });
    db.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ? AND status = 'open'").run(d.id);
    return { draft: draftView(s.store.draft(id)) };
  });

  app.post('/api/threads/:id/send', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const t = s.store.thread(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const d = s.store.draft(String(req.body?.draftId ?? ''));
    if (!d || d.thread_id !== t.id) return reply.code(400).send({ error: 'draft does not belong to this thread' });
    if (!canSendFrom(s.scope, t.mailbox_id)) return reply.code(403).send({ error: 'partner_cannot_send', message: 'this mailbox has not allowed you to send' });
    try {
      const r = queueSend(s.store, { userId: s.user.id, draftId: d.id, bodyText: req.body?.body, sendAt: req.body?.sendAt });
      return { sendId: r.sendId, undoUntil: r.undoUntil, scheduledAt: r.scheduledAt };
    } catch (err) {
      if (err instanceof SendRefused) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // 予約送信: move it ({ sendAt }) or send it now ({ now: true }).
  app.post('/api/sends/:id/schedule', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    try {
      return rescheduleSend(s.store, { userId: s.user.id, sendId: req.params.id, sendAt: req.body?.sendAt, sendNow: req.body?.now === true });
    } catch (err) {
      if (err instanceof SendRefused) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/api/sends/:id/undo', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    try {
      cancelSend(s.store, { userId: s.user.id, sendId: req.params.id });
      return { ok: true };
    } catch (err) {
      if (err instanceof SendRefused) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });
}
