// apps/server/src/routes/calendar.js — calendar actions in the console (plan step 11 onward).
// Dark: every route is 404 while the business's calendar_mode is 'off'. Partners act only on
// suggestions of mailboxes they can see (D8, accessScope/canSee).
import { currentSession } from '../auth.js';
import { accessScope, canSee, canSendFrom } from '../partner.js';
import { calendarVisibleFor, calendarView } from '../calendar-board.js';
import { holdSuggestion, dismissSuggestion, HoldError } from '../suggestions.js';
import { CalendarWriteError } from '../calendar-writes.js';
import { freeSlots, slotsInstruction, FreeSlotError } from '../free-slots.js';
import { draftOnRequest } from '../drafting.js';
import { gmailFor } from '../mailboxes.js';
import { Store } from '../store.js';
import { confirm, undo, cancel, applyChange, setInvite, MeetingError } from '../meetings.js';
import { confirmDeadline, dismissDeadline, completeDeadline, deadlineView, todayIn, DeadlineError } from '../deadlines.js';

const STATUS = { not_found: 404, not_open: 409, not_holdable: 409, past: 409, bad_time: 400, bad_mailbox: 400, bad_thread: 400, not_confirmed: 409, no_change: 409, invite_sent: 409, no_attendees: 400, not_queueable: 409 };

/**
 * @param {{db, config, clientFor: (mailbox) => Calendar}} o  clientFor is calendarFor bound to the
 *   service-account tokens (app.js builds it lazily; tests inject a fake).
 */
export function registerCalendarRoutes(app, { db, config, ai, gmailFactory, clientFor, meetWait }) {
  const gmailOf = (mailbox) => gmailFor(mailbox, config, gmailFactory);
  const auth = (req, reply) => {
    const s = currentSession(db, req, config.masterKey);
    if (!s) { reply.code(401).send({ error: 'sign in required' }); return null; }
    const mode = db.prepare('SELECT calendar_mode FROM businesses WHERE id = ?').get(s.business.id)?.calendar_mode;
    // D45: off = nothing; shadow = owners only (the admin view); on = everyone, within their scope.
    if (!calendarVisibleFor(mode, s.user)) { reply.code(404).send({ error: 'not found' }); return null; }
    return { ...s, scope: accessScope(db, s.user) };
  };
  const suggestionFor = (s, id, reply) => {
    const row = db.prepare('SELECT * FROM suggestions WHERE id = ? AND business_id = ?').get(id, s.business.id);
    if (!row) { reply.code(404).send({ error: 'not found' }); return null; }
    if (!canSee(s.scope, row.mailbox_id)) { reply.code(403).send({ error: 'not your mailbox' }); return null; }
    return row;
  };
  const fail = (reply, err) => {
    if (err instanceof DeadlineError) return reply.code(STATUS[err.code] ?? 400).send({ error: err.code, message: err.message });
    if (err instanceof FreeSlotError) return reply.code(409).send({ error: err.code, message: err.message });
    if (err instanceof MeetingError) return reply.code(STATUS[err.code] ?? 400).send({ error: err.code, message: err.message });
    if (err instanceof HoldError) return reply.code(STATUS[err.code] ?? 400).send({ error: err.code, message: err.message });
    // Fail closed (no owner, no calendar) or a hand edit: nothing was placed or deleted.
    if (err instanceof CalendarWriteError) return reply.code(409).send({ error: err.code, message: err.message });
    return reply.code(502).send({ error: 'calendar_error', message: String(err.message).slice(0, 300) });
  };
  const audit = (s, action, target) => db.prepare('INSERT INTO audit_log (business_id, user_id, action, target) VALUES (?, ?, ?, ?)')
    .run(s.business.id, s.user.id, action, target);

  // D23: a date offered to us becomes a hold after one click.
  app.post('/api/suggestions/:id/hold', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const row = suggestionFor(s, req.params.id, reply); if (!row) return;
    try {
      const h = await holdSuggestion({ db, businessId: s.business.id, suggestionId: row.id, clientFor });
      audit(s, 'suggestion_hold', row.id);
      return { hold: { id: h.id, state: h.state, googleEventId: h.google_event_id } };
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/suggestions/:id/dismiss', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const row = suggestionFor(s, req.params.id, reply); if (!row) return;
    try {
      const r = await dismissSuggestion({ db, businessId: s.business.id, suggestionId: row.id, clientFor });
      audit(s, 'suggestion_dismiss', row.id);
      return r;
    } catch (err) { return fail(reply, err); }
  });

  // Step 12 (D4, D9): a reply offering 3 free slots of the thread owner plus ticked attendees. The sent
  // draft then yields 'ours' suggestions (step 9) and holds (step 11). Attendees are only read (freeBusy).
  app.post('/api/threads/:id/draft-slots', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const store = new Store(db, s.business.id);
    const thread = store.thread(req.params.id);
    if (!thread || !canSee(s.scope, thread.mailbox_id)) return reply.code(404).send({ error: 'not found' });
    if (!ai) return reply.code(503).send({ error: 'AI not configured' });
    const ids = Array.isArray(req.body?.attendeeMailboxIds) ? [...new Set(req.body.attendeeMailboxIds.map(String))].slice(0, 10) : [];
    const attendees = [];
    for (const id of ids) {
      const m = store.mailbox(id);
      if (!m || !canSee(s.scope, id)) return reply.code(403).send({ error: 'not your mailbox', mailboxId: id });
      if (id !== thread.mailbox_id) attendees.push(m);
    }
    const owner = store.mailbox(thread.mailbox_id);
    try {
      const { slots } = await freeSlots({ business: store.business(), ownerMailbox: owner, attendeeMailboxes: attendees, clientFor });
      if (!slots.length) return reply.code(409).send({ error: 'no_free_slots', message: 'no free time in the next 14 days' });
      const tz = store.business().timezone || 'Asia/Tokyo';
      const r = await draftOnRequest({ db, mailbox: owner, gmail: gmailFor(owner, config, gmailFactory), ai, thread, config, instruction: slotsInstruction(slots, tz) });
      if (r.status !== 'drafted') return reply.code(409).send({ error: r.reason });
      audit(s, 'draft_slots', thread.id);
      const d = store.latestDraft(thread.id);
      return { slots, draft: { id: d.id, version: d.version, body: d.body_text, status: d.status } };
    } catch (err) { return fail(reply, err); }
  });

  // ---- meetings (step 13): D29 + D40 anyone may confirm, partners only where they can send. -------
  const meetingFor = (s, id, reply) => {
    const m = db.prepare('SELECT * FROM meetings WHERE id = ? AND business_id = ?').get(id, s.business.id);
    if (!m || !canSee(s.scope, m.mailbox_id)) { reply.code(404).send({ error: 'not found' }); return null; }
    if (!canSendFrom(s.scope, m.mailbox_id)) { reply.code(403).send({ error: 'partner_cannot_send' }); return null; }
    return m;
  };
  const meetingView = (m) => m && ({
    id: m.id, threadId: m.thread_id, mailboxId: m.mailbox_id, start: m.start_utc, end: m.end_utc, title: m.title, place: m.place,
    link: m.link_url, linkSource: m.link_source, conference: m.conference_status, state: m.state, invite: m.invite_state, pendingChange: m.pending_change_suggestion_id ?? null,
  });
  const draftOut = (d) => d && ({ id: d.id, version: d.version, body: d.body_text, status: d.status });

  app.post('/api/meetings/confirm', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const b = req.body ?? {};
    let mailboxId;
    if (b.suggestionId) {
      const row = suggestionFor(s, String(b.suggestionId), reply); if (!row) return;
      mailboxId = row.mailbox_id;
    } else {
      mailboxId = String(b.mailboxId ?? '');
      if (!canSee(s.scope, mailboxId)) return reply.code(404).send({ error: 'not found' });
    }
    if (!canSendFrom(s.scope, mailboxId)) return reply.code(403).send({ error: 'partner_cannot_send', message: 'confirming needs send rights on this mailbox' });
    try {
      const r = await confirm({ db, config, ai, gmailFor: gmailOf, clientFor, businessId: s.business.id, user: s.user, meetWait,
        input: b.suggestionId ? { suggestionId: String(b.suggestionId) } : { mailboxId, start: b.start, end: b.end, title: b.title, place: b.place, threadId: b.threadId },
        idemKey: b.idemKey, wantInvite: b.wantInvite === true, inviteAttendees: Array.isArray(b.inviteAttendees) ? b.inviteAttendees : undefined });
      return { meeting: meetingView(r.meeting), draft: draftOut(r.draft), draftError: r.draftError ?? null, created: r.created };
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/meetings/:id/undo', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const m = meetingFor(s, req.params.id, reply); if (!m) return;
    try {
      const r = await undo({ db, config, ai, gmailFor: gmailOf, clientFor, businessId: s.business.id, user: s.user, meetingId: m.id });
      return { meeting: meetingView(r.meeting), draft: draftOut(r.draft), draftError: r.draftError ?? null };
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/meetings/:id/cancel', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const m = meetingFor(s, req.params.id, reply); if (!m) return;
    try {
      const r = await cancel({ db, clientFor, businessId: s.business.id, user: s.user, meetingId: m.id });
      return { meeting: meetingView(r.meeting) };
    } catch (err) { return fail(reply, err); }
  });

  // Step 14 (D13): apply the "変更の提案" with one click.
  app.post('/api/meetings/:id/apply-change', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const m = meetingFor(s, req.params.id, reply); if (!m) return;
    try {
      const r = await applyChange({ db, clientFor, businessId: s.business.id, user: s.user, meetingId: m.id });
      return { meeting: meetingView(r.meeting) };
    } catch (err) { return fail(reply, err); }
  });

  // Step 15 (D41): the "Google 招待も送る" tick on the confirmation draft. No Google call here.
  app.post('/api/meetings/:id/invite', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const m = meetingFor(s, req.params.id, reply); if (!m) return;
    try {
      const r = setInvite({ db, businessId: s.business.id, user: s.user, meetingId: m.id, want: req.body?.want === true,
        attendees: Array.isArray(req.body?.attendees) ? req.body.attendees.map(String).slice(0, 20) : undefined });
      return { meeting: meetingView(r.meeting) };
    } catch (err) { return fail(reply, err); }
  });

  // 締切 (D54, D56, D57): confirm the AI's flag with one click, dismiss it, or mark it 完了 by hand.
  // Same rights as a suggestion: the viewer must see the deadline's mailbox.
  const deadlineActions = { confirm: confirmDeadline, dismiss: dismissDeadline, done: completeDeadline };
  for (const [action, fn] of Object.entries(deadlineActions)) {
    app.post(`/api/deadlines/:id/${action}`, async (req, reply) => {
      const s = auth(req, reply); if (!s) return;
      const d = db.prepare('SELECT * FROM deadlines WHERE id = ? AND business_id = ?').get(req.params.id, s.business.id);
      if (!d) return reply.code(404).send({ error: 'not found' });
      if (!canSee(s.scope, d.mailbox_id)) return reply.code(403).send({ error: 'not your mailbox' });
      try {
        const r = fn(db, { businessId: s.business.id, id: d.id, userId: s.user.id });
        audit(s, `deadline_${action}`, d.id);
        const tz = s.business.timezone || 'Asia/Tokyo';
        return { deadline: deadlineView(r, tz, todayIn(tz)) };
      } catch (err) { return fail(reply, err); }
    });
  }

  // Step 17: the Calendar tab. view=person:<mailboxId>|team; rows limited by accessScope, private fields
  // stripped per viewer (D16, D34, D39).
  app.get('/api/calendar', async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const day = 86_400_000;
    const from = Number.isFinite(Date.parse(req.query?.from)) ? new Date(req.query.from).toISOString() : new Date(Date.now() - 7 * day).toISOString();
    let to = Number.isFinite(Date.parse(req.query?.to)) ? new Date(req.query.to).toISOString() : new Date(Date.parse(from) + 42 * day).toISOString();
    if (Date.parse(to) - Date.parse(from) > 62 * day) to = new Date(Date.parse(from) + 62 * day).toISOString();
    const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(s.business.id);
    const r = calendarView(db, { business, user: s.user, scope: s.scope, from, to, view: req.query?.view ? String(req.query.view) : null });
    if (r.error) return reply.code(r.status).send({ error: r.error });
    return r;
  });
}
