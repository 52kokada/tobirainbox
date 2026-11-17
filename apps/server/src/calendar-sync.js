// apps/server/src/calendar-sync.js — read sync of Google calendars into calendar_events (plan step 6).
// Per business: each mailbox's primary calendar plus the 調整中 calendar (its shadow twin in shadow mode).
// First pass (and once a week, to slide the window): a full list, -30/+120 days, singleEvents=true,
// storing the syncToken. Later passes send only the syncToken (Google rejects timeMin with one), apply
// changes, and prune rows outside the window locally. 410 Gone means a full resync. Read only: it never
// writes to Google and shares no code path with sending (deliverDue) or the CRM outbox.
import { meetingLinks } from './meeting-links.js';

export const WINDOW_PAST_DAYS = 30;
export const WINDOW_FUTURE_DAYS = 120;
export const FULL_RESYNC_DAYS = 7;
export const ALERT_AFTER_FAILURES = 3;
const DAY = 86_400_000;

/** Offset (ms) of a timezone at an instant: local wall time minus UTC. */
function tzOffsetMs(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** Midnight of an all-day date ("2026-11-10") in the business timezone, as UTC ISO. */
export function zonedMidnightUtc(date, tz) {
  const [y, m, d] = String(date).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - tzOffsetMs(wall, tz);
  t = wall - tzOffsetMs(t, tz);
  return new Date(t).toISOString();
}

const utc = (when, tz) => (when?.dateTime ? new Date(when.dateTime).toISOString() : when?.date ? zonedMidnightUtc(when.date, tz) : null);

/** A Google event as a calendar_events row (full fields; calendar-view strips private ones per viewer). */
export function eventRow(ev, tz) {
  const tag = ev.extendedProperties?.private;
  const video = ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri
    ?? meetingLinks(`${ev.location ?? ''} ${ev.description ?? ''}`)[0]?.url ?? null;
  return {
    google_event_id: ev.id, etag: ev.etag ?? null,
    start_utc: utc(ev.start, tz), end_utc: utc(ev.end, tz), all_day: ev.start?.date && !ev.start?.dateTime ? 1 : 0,
    title: ev.summary ?? null, location: ev.location ?? null, meet_url: video,
    visibility: ev.visibility ?? 'default',
    ours_tag: tag?.tobiraInbox === '1' ? `${tag.tbiKind ?? ''}:${tag.tbiId ?? ''}` : null,
    status: ev.status ?? 'confirmed', updated_at: ev.updated ?? null,
  };
}

/**
 * Calendars a business reads, each with the mailbox whose token reads it. Delegated businesses read
 * every connected mailbox; per_mailbox ones only mailboxes with a calendar consent. The 調整中 calendar
 * (mailbox_id NULL) is read as its owner; in shadow mode the shadow calendar replaces it.
 */
export function calendarsToSync(db, businessId) {
  const b = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!b || b.calendar_mode === 'off') return [];
  const boxes = db.prepare(`SELECT * FROM mailboxes WHERE business_id = ? AND status = 'connected'${b.calendar_access === 'per_mailbox' ? ' AND calendar_token_enc IS NOT NULL' : ''} ORDER BY address`).all(businessId);
  const out = boxes.map((m) => ({ mailboxId: m.id, calendarId: m.address, mailbox: m }));
  const holdId = b.calendar_mode === 'shadow' ? b.shadow_calendar_id : b.hold_calendar_id;
  const owner = boxes.find((m) => m.id === b.hold_calendar_owner_mailbox_id);
  if (holdId && owner) out.push({ mailboxId: null, calendarId: holdId, mailbox: owner });
  return out;
}

function syncRow(db, businessId, target) {
  db.prepare('INSERT OR IGNORE INTO calendar_sync (business_id, mailbox_id, google_calendar_id) VALUES (?, ?, ?)').run(businessId, target.mailboxId, target.calendarId);
  return db.prepare('SELECT * FROM calendar_sync WHERE business_id = ? AND google_calendar_id = ?').get(businessId, target.calendarId);
}

function upsert(db, businessId, target, row) {
  db.prepare(`INSERT INTO calendar_events (business_id, mailbox_id, google_calendar_id, google_event_id, etag, start_utc, end_utc, all_day, title, location, meet_url, visibility, ours_tag, status, updated_at)
      VALUES (@business_id, @mailbox_id, @google_calendar_id, @google_event_id, @etag, @start_utc, @end_utc, @all_day, @title, @location, @meet_url, @visibility, @ours_tag, @status, @updated_at)
      ON CONFLICT (business_id, google_calendar_id, google_event_id) DO UPDATE SET mailbox_id = excluded.mailbox_id, etag = excluded.etag,
        start_utc = excluded.start_utc, end_utc = excluded.end_utc, all_day = excluded.all_day, title = excluded.title, location = excluded.location,
        meet_url = excluded.meet_url, visibility = excluded.visibility, ours_tag = excluded.ours_tag, status = excluded.status, updated_at = excluded.updated_at`)
    .run({ business_id: businessId, mailbox_id: target.mailboxId, google_calendar_id: target.calendarId, ...row });
}

const removeEvent = (db, businessId, calendarId, eventId) => db.prepare('DELETE FROM calendar_events WHERE business_id = ? AND google_calendar_id = ? AND google_event_id = ?').run(businessId, calendarId, eventId);

/** One calendar, one pass. Returns { ok, full, changed } or { ok: false, error, errorCount }. */
export async function syncCalendar({ db, businessId, target, client, now = Date.now() }) {
  const tz = db.prepare('SELECT timezone FROM businesses WHERE id = ?').get(businessId)?.timezone || 'Asia/Tokyo';
  const state = syncRow(db, businessId, target);
  const windowFrom = new Date(now - WINDOW_PAST_DAYS * DAY).toISOString();
  const windowTo = new Date(now + WINDOW_FUTURE_DAYS * DAY).toISOString();
  const stale = !state.window_from || now - (Date.parse(state.window_from) + WINDOW_PAST_DAYS * DAY) >= FULL_RESYNC_DAYS * DAY;
  const at = new Date(now).toISOString();
  const markMailbox = (status, error) => {
    if (target.mailboxId) db.prepare(`UPDATE mailboxes SET calendar_status = ?, calendar_error = ?${status === 'ok' ? ', calendar_synced_at = ?' : ''} WHERE id = ?`)
      .run(...(status === 'ok' ? [status, null, at, target.mailboxId] : [status, error, target.mailboxId]));
  };

  const full = async () => {
    const { items, nextSyncToken } = await client.listEvents(target.calendarId, { timeMin: windowFrom, timeMax: windowTo });
    db.transaction(() => {
      db.prepare('DELETE FROM calendar_events WHERE business_id = ? AND google_calendar_id = ?').run(businessId, target.calendarId);
      for (const ev of items) if (ev.status !== 'cancelled') upsert(db, businessId, target, eventRow(ev, tz));
      db.prepare('UPDATE calendar_sync SET sync_token = ?, window_from = ?, window_to = ?, last_ok_at = ?, last_error = NULL, error_count = 0 WHERE id = ?')
        .run(nextSyncToken, windowFrom, windowTo, at, state.id);
    })();
    return { ok: true, full: true, changed: items.length };
  };

  try {
    let r;
    if (!state.sync_token || stale) r = await full();
    else {
      let res;
      try { res = await client.listEvents(target.calendarId, { syncToken: state.sync_token }); }
      catch (err) { if (err.status === 410) res = null; else throw err; }
      if (!res) r = await full();
      else {
        db.transaction(() => {
          for (const ev of res.items) {
            if (ev.status === 'cancelled') removeEvent(db, businessId, target.calendarId, ev.id);
            else upsert(db, businessId, target, eventRow(ev, tz));
          }
          // Keep only the window (by start); Google keeps sending changes to events outside it.
          db.prepare('DELETE FROM calendar_events WHERE business_id = ? AND google_calendar_id = ? AND (start_utc < ? OR start_utc > ?)')
            .run(businessId, target.calendarId, state.window_from, state.window_to);
          db.prepare('UPDATE calendar_sync SET sync_token = ?, last_ok_at = ?, last_error = NULL, error_count = 0 WHERE id = ?')
            .run(res.nextSyncToken ?? state.sync_token, at, state.id);
        })();
        r = { ok: true, full: false, changed: res.items.length };
      }
    }
    markMailbox('ok');
    return r;
  } catch (err) {
    const msg = String(err.message ?? err).slice(0, 300);
    db.prepare('UPDATE calendar_sync SET last_error = ?, error_count = error_count + 1 WHERE id = ?').run(msg, state.id);
    markMailbox('error', msg);
    return { ok: false, error: msg, errorCount: state.error_count + 1 };
  }
}

/**
 * Every calendar of every business whose calendar_mode is not 'off'. clientFor(mailbox) gives a
 * Calendar. alerts: { raise, resolve } (alerts.js); a calendar alerts after ALERT_AFTER_FAILURES
 * failed passes in a row and the alert closes on its next good pass.
 */
export async function calendarPass({ db, clientFor, alerts = null, now = Date.now() }) {
  const out = [];
  const businesses = db.prepare("SELECT id FROM businesses WHERE calendar_mode != 'off' AND status = 'active'").all();
  for (const { id: businessId } of businesses) {
    for (const target of calendarsToSync(db, businessId)) {
      let r;
      // A client that cannot be built (no signer, no consent) counts as a failed pass like any Google error.
      let client;
      try { client = clientFor(target.mailbox); } catch (err) { client = { listEvents: async () => { throw err; } }; }
      try { r = await syncCalendar({ db, businessId, target, client, now }); }
      catch (err) { r = { ok: false, error: err.message }; }
      const key = `${businessId}:${target.calendarId}`;
      if (alerts) {
        if (r.ok) alerts.resolve(db, { businessId, kind: 'calendar_sync', key });
        else if ((r.errorCount ?? 0) >= ALERT_AFTER_FAILURES) {
          alerts.raise(db, { businessId, kind: 'calendar_sync', key, title: `カレンダーを読み込めません：${target.mailboxId ? target.mailbox.address : '調整中カレンダー'}`.slice(0, 120), body: r.error });
        }
      }
      out.push({ businessId, calendarId: target.calendarId, ...r });
    }
  }
  return out;
}

/** Manual trigger: the next pass does a full resync of this business's calendars. */
export function requestResync(db, businessId) {
  return db.prepare('UPDATE calendar_sync SET sync_token = NULL, window_from = NULL WHERE business_id = ?').run(businessId).changes;
}
