// apps/server/src/meetings.js — confirm, undo and cancel a meeting (calendar plan step 13).
// D37: the confirmation draft is written only after the Google write succeeded. D27: the event goes on
// the mailbox's own calendar, with no attendees and sendUpdates 'none' (calendar-writes.js does every
// Google write). D11: the meeting link from the mail, else a new Meet (requestId = meetings.id,
// conferenceDataVersion=1); a Meet still pending after 5 polls over 10 s leaves a 【要確認】 blank, so
// send-queue refuses to send it until a person fills it. In person: the address goes in location.
// D33: undo deletes our event and drafts a correction email; it has no time limit (plan §8.9).
import { makeBlank, utcToLocal } from '@tobira-inbox/engine';
import { newId, Store } from './store.js';
import { confirmMeeting, undoConfirm, cancelMeeting, moveMeeting, releaseHold, cancelInvite, queueInvite, sendInvite, CalendarWriteError } from './calendar-writes.js';
import { meetingLinkForThread } from './meeting-links.js';
import { parseMessage } from './gmail.js';
import { draftOnRequest } from './drafting.js';
import { cancelSend } from './send-queue.js';

export class MeetingError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

export const MEET_POLLS = 5;
export const MEET_POLL_MS = 2000; // 5 polls over 10 s (plan §8.6)
const MIN = 60_000;
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const TZ_JA = { 'Asia/Tokyo': '日本時間' };

/** "11月10日(火) 10:00〜10:30（日本時間）" */
export function whenLabel(startUtc, endUtc, tz) {
  const a = utcToLocal(startUtc, tz); const b = utcToLocal(endUtc, tz);
  const [, m, d] = a.local.slice(0, 10).split('-').map(Number);
  return `${m}月${d}日(${WD[a.weekday]}) ${a.local.slice(11)}〜${b.local.slice(11)}（${TZ_JA[tz] ?? tz}）`;
}

/** The Meet link of a Google event once its conference is ready, else null. */
export function meetLinkOf(ev) {
  return ev?.hangoutLink ?? ev?.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? null;
}
const conferenceStatus = (ev) => ev?.conferenceData?.createRequest?.status?.statusCode ?? (meetLinkOf(ev) ? 'success' : null);

/** Read the event until its Meet is ready (or failed), at most MEET_POLLS times. → { status, url } */
async function waitForMeet(client, calendarId, ev, { polls = MEET_POLLS, wait = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = MEET_POLL_MS } = {}) {
  let cur = ev;
  for (let i = 0; ; i += 1) {
    const st = conferenceStatus(cur);
    if (st === 'success' && meetLinkOf(cur)) return { status: 'ready', url: meetLinkOf(cur) };
    if (st === 'failure') return { status: 'failed', url: null };
    if (i >= polls) return { status: 'pending', url: null };
    await wait(pollMs);
    try { cur = await client.getEvent(calendarId, ev.id); } catch { /* keep polling */ }
  }
}

function threadMessages(gmail, thread) {
  return gmail.getThread(thread.gmail_thread_id).then((raw) => (raw.messages ?? []).map(parseMessage).filter((m) => !m.reaction));
}

/** The other party's address on the thread (for the invite list), never one of ours. */
export function counterpartEmail(thread) {
  const m = /<([^>]+)>/.exec(thread?.cache_from ?? '') ?? /([^\s<>]+@[^\s<>]+)/.exec(thread?.cache_from ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** Save the AI draft as the meeting's draft, making sure the link (or its blank) is in the text. */
function finishDraft(db, store, { draftId, meeting, purpose, linkLine }) {
  if (!draftId) return null;
  const d = store.draft(draftId);
  if (linkLine && !d.body_text.includes(linkLine.needle)) {
    db.prepare('UPDATE drafts SET body_text = ? WHERE id = ?').run(`${d.body_text.trimEnd()}\n\n${linkLine.text}`, d.id);
  }
  db.prepare('UPDATE drafts SET meeting_id = ?, meeting_purpose = ? WHERE id = ?').run(meeting.id, purpose, d.id);
  return store.draft(d.id);
}

/**
 * Confirm a meeting from a suggestion, or manually (no thread needed, D5). Idempotent per idemKey: a second
 * call returns the same meeting and makes no second event or draft.
 * @param o.input { suggestionId } | { mailboxId, start, end, title, place, threadId }
 * → { meeting, draft, created }
 */
export async function confirm({ db, config = {}, ai, gmailFor, clientFor, businessId, user, input, idemKey, wantInvite = false, inviteAttendees, now = new Date(), meetWait }) {
  const store = new Store(db, businessId);
  const biz = store.business();
  const tz = biz.timezone || 'Asia/Tokyo';
  let s = null; let mailboxId; let start; let end; let threadId; let title; let place = input.place ? String(input.place).slice(0, 300) : null;
  if (input.suggestionId) {
    s = store.suggestion(input.suggestionId);
    if (!s) throw new MeetingError('not_found');
    const done = db.prepare('SELECT * FROM meetings WHERE idem_key = ? AND business_id = ? AND google_event_id IS NOT NULL').get(String(idemKey || `confirm:${s.id}`).slice(0, 200), businessId);
    if (done) return { meeting: done, draft: db.prepare("SELECT * FROM drafts WHERE meeting_id = ? AND meeting_purpose = 'confirm' ORDER BY version DESC LIMIT 1").get(done.id) ?? null, created: false };
    if (!['suggested', 'held'].includes(s.state)) throw new MeetingError('not_open', `suggestion is ${s.state}`);
    mailboxId = s.mailbox_id; start = s.start_utc; end = s.end_utc ?? new Date(Date.parse(s.start_utc) + 30 * MIN).toISOString(); // D38
    threadId = s.thread_id; title = s.counterpart_label ? `${s.counterpart_label} 打ち合わせ` : '打ち合わせ';
  } else {
    mailboxId = String(input.mailboxId ?? '');
    const a = Date.parse(input.start); const b = input.end ? Date.parse(input.end) : a + 30 * MIN;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new MeetingError('bad_time');
    start = new Date(a).toISOString(); end = new Date(b).toISOString();
    threadId = input.threadId ? String(input.threadId) : null; title = String(input.title ?? '打ち合わせ').slice(0, 200);
  }
  const mailbox = store.mailbox(mailboxId);
  if (!mailbox) throw new MeetingError('bad_mailbox');
  const thread = threadId ? store.thread(threadId) : null;
  if (threadId && (!thread || thread.mailbox_id !== mailboxId)) throw new MeetingError('bad_thread');
  if (Date.parse(start) <= now.getTime()) throw new MeetingError('past', 'the time has passed');

  const key = String(idemKey || (s ? `confirm:${s.id}` : `confirm:${mailboxId}:${start}:${threadId ?? ''}`)).slice(0, 200);
  let meeting = db.prepare('SELECT * FROM meetings WHERE idem_key = ? AND business_id = ?').get(key, businessId);
  if (meeting?.google_event_id) {
    return { meeting, draft: db.prepare("SELECT * FROM drafts WHERE meeting_id = ? AND meeting_purpose = 'confirm' ORDER BY version DESC LIMIT 1").get(meeting.id) ?? null, created: false };
  }

  // The link: from the mail (D11), else a Meet unless the meeting is in person.
  let messages = [];
  if (thread) { try { messages = await threadMessages(gmailFor(mailbox), thread); } catch { messages = []; } }
  const found = meetingLinkForThread(messages);
  const linkSource = found ? 'mail' : place ? 'none' : 'meet';
  if (!meeting) {
    const id = newId();
    db.prepare(`INSERT INTO meetings (id, business_id, thread_id, mailbox_id, start_utc, end_utc, title, place, link_url, link_source, conference_status,
        confirmed_by_user_id, confirmed_via, idem_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'console', ?)`)
      .run(id, businessId, thread?.id ?? null, mailboxId, start, end, title, place, found?.url ?? null, linkSource, linkSource === 'meet' ? 'pending' : 'none', user.id, key);
    meeting = store.meeting(id);
  }
  const description = [found ? `会議リンク: ${found.url}` : null, thread && config.publicUrl ? `TobirAInbox: ${config.publicUrl}/#t=${thread.id}` : null].filter(Boolean).join('\n') || undefined;
  // The Google write first (D37). A failure throws here: no draft, the calendar_writes row stays failed.
  const ev = await confirmMeeting({ db, businessId, meeting, mailbox, clientFor, description, conferenceRequestId: linkSource === 'meet' ? meeting.id : undefined });
  if (linkSource === 'meet') {
    const target = db.prepare('SELECT google_calendar_id FROM meetings WHERE id = ?').get(meeting.id).google_calendar_id;
    const owner = biz.calendar_mode === 'shadow'
      ? db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(biz.hold_calendar_owner_mailbox_id) : mailbox;
    const r = await waitForMeet(clientFor(owner), target, ev, meetWait);
    db.prepare('UPDATE meetings SET link_url = ?, conference_status = ? WHERE id = ?').run(r.url, r.status, meeting.id);
  }
  meeting = store.meeting(meeting.id);

  // Close the thread's open suggestions and release its other holds (D4: leftovers dropped on confirm).
  if (s || thread) {
    const gmailThread = s?.gmail_thread_id ?? thread.gmail_thread_id;
    const open = db.prepare("SELECT * FROM suggestions WHERE business_id = ? AND mailbox_id = ? AND gmail_thread_id = ? AND state IN ('suggested','held')").all(businessId, mailboxId, gmailThread);
    for (const o of open) {
      for (const h of db.prepare("SELECT * FROM holds WHERE suggestion_id = ? AND state = 'active'").all(o.id)) {
        try {
          await releaseHold({ db, businessId, hold: h, clientFor, reason: 'confirm' });
          db.prepare("UPDATE holds SET state = 'confirmed_away', meeting_id = ? WHERE id = ?").run(meeting.id, h.id);
        } catch (err) {
          db.prepare("UPDATE holds SET state = 'flagged', flagged_reason = ?, meeting_id = ? WHERE id = ?").run(`release on confirm: ${String(err.message).slice(0, 200)}`, meeting.id, h.id);
        }
      }
      db.prepare("UPDATE suggestions SET state = 'superseded', meeting_id = ? WHERE id = ?").run(meeting.id, o.id);
    }
  }

  if (wantInvite) {
    const list = inviteAttendees?.length ? inviteAttendees : [counterpartEmail(thread)].filter(Boolean);
    if (list.length) queueInvite(db, { businessId, meetingId: meeting.id, attendees: list });
    meeting = store.meeting(meeting.id);
  }

  // The confirmation draft, only now that Google has the event (D37).
  let draft = null; let draftError = null;
  if (thread && ai) {
    const stated = s?.stated_tz && s.stated_tz !== tz ? ` / ${whenLabel(start, end, s.stated_tz)}` : '';
    const where = meeting.place ? `場所: ${meeting.place}` : meeting.link_url ? `会議リンク: ${meeting.link_url}` : '会議リンクは追ってお送りする';
    const instruction = `日程が確定したことを伝える返信にしてください。日時: ${whenLabel(start, end, tz)}${stated}。${where}。`;
    const linkLine = meeting.place ? null
      : meeting.link_url ? { needle: meeting.link_url, text: `会議リンク：${meeting.link_url}` }
        : { needle: '【要確認', text: `会議リンク：${makeBlank('会議リンク（Google Meet の作成が終わっていません）')}` };
    // The meeting is in Google already: a drafting failure is reported, never turned into a failed confirm.
    try {
      const r = await draftOnRequest({ db, mailbox, gmail: gmailFor(mailbox), ai, thread, config, instruction });
      draft = finishDraft(db, store, { draftId: r.status === 'drafted' ? r.draftId : null, meeting, purpose: 'confirm', linkLine });
      if (!draft) draftError = r.reason ?? 'not drafted';
    } catch (err) { draftError = String(err.message).slice(0, 200); }
  }
  store.audit(user.id, 'meeting_confirmed', meeting.id, { suggestionId: s?.id ?? null });
  return { meeting, draft, draftError, created: true };
}

/**
 * Undo a wrong confirm (D33): delete our event (sendUpdates 'none' unless an invite went out), put the
 * suggestions it closed back to 'suggested', stop an unsent confirmation, and draft a correction when the
 * confirmation email was already delivered. → { meeting, draft }
 */
export async function undo({ db, config = {}, ai, gmailFor, clientFor, businessId, user, meetingId, now = new Date() }) {
  const store = new Store(db, businessId);
  let meeting = store.meeting(meetingId);
  if (!meeting) throw new MeetingError('not_found');
  if (meeting.state === 'undone') return { meeting, draft: null };
  if (meeting.state !== 'confirmed') throw new MeetingError('not_confirmed', `meeting is ${meeting.state}`);
  const mailbox = store.mailbox(meeting.mailbox_id);
  if (meeting.invite_state === 'queued') await cancelInvite({ db, businessId, meeting, mailbox, clientFor });
  await undoConfirm({ db, businessId, meeting: store.meeting(meeting.id), mailbox, clientFor });
  db.prepare("UPDATE meetings SET state = 'undone' WHERE id = ?").run(meeting.id);
  db.prepare("UPDATE suggestions SET state = 'suggested', meeting_id = NULL WHERE meeting_id = ? AND start_utc > ?").run(meeting.id, now.toISOString());

  const drafts = db.prepare("SELECT * FROM drafts WHERE meeting_id = ? AND meeting_purpose = 'confirm'").all(meeting.id);
  for (const d of drafts) {
    if (d.status === 'queued') {
      const send = db.prepare("SELECT id FROM sends WHERE draft_id = ? AND status = 'queued'").get(d.id);
      if (send) { try { cancelSend(store, { userId: user.id, sendId: send.id, now }); } catch { /* already leaving: the correction covers it */ } }
    }
    db.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ? AND status = 'open'").run(d.id);
  }
  const delivered = db.prepare("SELECT 1 FROM drafts WHERE meeting_id = ? AND meeting_purpose = 'confirm' AND status = 'sent'").get(meeting.id);
  meeting = store.meeting(meeting.id);
  let draft = null; let draftError = null;
  const thread = meeting.thread_id ? store.thread(meeting.thread_id) : null;
  if (delivered && thread && ai) {
    const tz = store.business().timezone || 'Asia/Tokyo';
    const instruction = `先にお送りした日程確定（${whenLabel(meeting.start_utc, meeting.end_utc, tz)}）は誤りでした。お詫びして取り消し、改めて日程を相談する返信にしてください。`;
    try {
      const r = await draftOnRequest({ db, mailbox, gmail: gmailFor(mailbox), ai, thread, config, instruction });
      draft = finishDraft(db, store, { draftId: r.status === 'drafted' ? r.draftId : null, meeting, purpose: 'correction' });
      if (!draft) draftError = r.reason ?? 'not drafted';
    } catch (err) { draftError = String(err.message).slice(0, 200); }
  }
  store.audit(user.id, 'meeting_undone', meeting.id);
  return { meeting, draft, draftError };
}

/** Cancel a meeting: delete our event; attendees hear about it only if an invite went out (step 14). */
export async function cancel({ db, clientFor, businessId, user, meetingId }) {
  const store = new Store(db, businessId);
  const meeting = store.meeting(meetingId);
  if (!meeting) throw new MeetingError('not_found');
  if (meeting.state === 'cancelled') return { meeting };
  if (meeting.state !== 'confirmed') throw new MeetingError('not_confirmed', `meeting is ${meeting.state}`);
  const mailbox = store.mailbox(meeting.mailbox_id);
  if (meeting.invite_state === 'queued') await cancelInvite({ db, businessId, meeting, mailbox, clientFor });
  await cancelMeeting({ db, businessId, meeting: store.meeting(meeting.id), mailbox, clientFor });
  db.prepare("UPDATE meetings SET state = 'cancelled' WHERE id = ?").run(meeting.id);
  store.audit(user.id, 'meeting_cancelled', meeting.id);
  return { meeting: store.meeting(meeting.id) };
}

/**
 * Apply the meeting's pending change (D13, one click). A change moves our event with a patch guarded by
 * the stored etag; a cancel deletes our tagged event. Attendees are told (sendUpdates 'all') only when an
 * invite went out, else 'none' (calendar-writes decides). → { meeting }
 */
export async function applyChange({ db, clientFor, businessId, user, meetingId }) {
  const store = new Store(db, businessId);
  const meeting = store.meeting(meetingId);
  if (!meeting) throw new MeetingError('not_found');
  if (meeting.state !== 'confirmed') throw new MeetingError('not_confirmed', `meeting is ${meeting.state}`);
  const s = meeting.pending_change_suggestion_id && store.suggestion(meeting.pending_change_suggestion_id);
  if (!s || s.state !== 'suggested') throw new MeetingError('no_change', 'no change is waiting');
  const mailbox = store.mailbox(meeting.mailbox_id);
  if (s.kind === 'cancel') {
    if (meeting.invite_state === 'queued') await cancelInvite({ db, businessId, meeting, mailbox, clientFor });
    await cancelMeeting({ db, businessId, meeting: store.meeting(meeting.id), mailbox, clientFor });
    db.prepare("UPDATE meetings SET state = 'cancelled', pending_change_suggestion_id = NULL WHERE id = ?").run(meeting.id);
  } else {
    const len = Date.parse(meeting.end_utc) - Date.parse(meeting.start_utc);
    const endUtc = s.end_utc ?? new Date(Date.parse(s.start_utc) + (len > 0 ? len : 30 * MIN)).toISOString();
    await moveMeeting({ db, businessId, meeting, mailbox, clientFor, startUtc: s.start_utc, endUtc, idemKey: `${meeting.idem_key}:move:${s.id}` });
    db.prepare('UPDATE meetings SET start_utc = ?, end_utc = ?, pending_change_suggestion_id = NULL WHERE id = ?').run(s.start_utc, endUtc, meeting.id);
  }
  db.prepare("UPDATE suggestions SET state = 'superseded', meeting_id = ? WHERE id = ?").run(meeting.id, s.id);
  store.audit(user.id, s.kind === 'cancel' ? 'meeting_cancelled' : 'meeting_moved', meeting.id, { suggestionId: s.id });
  return { meeting: store.meeting(meeting.id) };
}

// ---- invite on Send (plan step 15; D41, D50) ------------------------------------------------------

/**
 * The person ticks or unticks "Google 招待も送る" on the confirmation draft. Ticking only stores the
 * attendees (no Google call); the invite goes out when that email is really delivered after its undo
 * window (sendDueInvites). → { meeting }
 */
export function setInvite({ db, businessId, user, meetingId, want, attendees }) {
  const store = new Store(db, businessId);
  const meeting = store.meeting(meetingId);
  if (!meeting) throw new MeetingError('not_found');
  if (meeting.state !== 'confirmed') throw new MeetingError('not_confirmed', `meeting is ${meeting.state}`);
  if (meeting.invite_state === 'sent') throw new MeetingError('invite_sent', 'the invite already went out; undo or cancel the meeting instead');
  if (want) {
    const list = attendees?.length ? attendees : [counterpartEmail(meeting.thread_id ? store.thread(meeting.thread_id) : null)].filter(Boolean);
    try { queueInvite(db, { businessId, meetingId, attendees: list }); } catch (err) { if (err instanceof CalendarWriteError) throw new MeetingError(err.code); throw err; }
  } else {
    db.prepare("UPDATE meetings SET invite_state = 'none' WHERE id = ? AND invite_state = 'queued'").run(meetingId);
  }
  store.audit(user.id, want ? 'invite_queued' : 'invite_unqueued', meetingId);
  return { meeting: store.meeting(meetingId) };
}

export const MAX_INVITE_ATTEMPTS = 5;

/**
 * Worker pass, after deliverDue: every queued invite whose confirmation email has been delivered (its
 * draft is 'sent', which only deliverDue sets after the undo window and a successful Gmail send) goes out
 * now, through calendar-writes (sendUpdates 'all'). Idempotent: an invite already sent is never sent
 * twice, and a failure stays queued for the next pass (at most MAX_INVITE_ATTEMPTS). Businesses with
 * calendar_mode 'off' are skipped. → [{ meetingId, ok, error? }]
 */
export async function sendDueInvites({ db, clientFor, log = console }) {
  const due = db.prepare(`SELECT m.* FROM meetings m JOIN businesses b ON b.id = m.business_id
    WHERE b.calendar_mode != 'off' AND m.state = 'confirmed' AND m.invite_state = 'queued' AND m.google_event_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM drafts d WHERE d.meeting_id = m.id AND d.meeting_purpose = 'confirm' AND d.status = 'sent')
      AND COALESCE((SELECT attempts FROM calendar_writes w WHERE w.idem_key = m.idem_key || ':invite'), 0) < ?`).all(MAX_INVITE_ATTEMPTS);
  const out = [];
  for (const m of due) {
    const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND business_id = ?').get(m.mailbox_id, m.business_id);
    try {
      await sendInvite({ db, businessId: m.business_id, meeting: m, mailbox, clientFor });
      db.prepare("INSERT INTO audit_log (business_id, action, target) VALUES (?, 'invite_sent', ?)").run(m.business_id, m.id);
      out.push({ meetingId: m.id, ok: true });
    } catch (err) {
      log.error?.(`invite ${m.id}: ${err.message}`);
      out.push({ meetingId: m.id, ok: false, error: err.message });
    }
  }
  return out;
}
