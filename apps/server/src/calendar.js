// apps/server/src/calendar.js — minimal Google Calendar REST client over fetch, like gmail.js, and
// calendarFor(mailbox): the one way calendar code gets a client. Calendar code never knows whether
// the token came from domain-wide delegation or a per-mailbox consent (D24, plan §3).
// Imports no Gmail, send, outbox or label module, so read-only bin/ scripts can use it.
import { refreshAccessToken } from './google.js';
import { tokenFor } from './token-source.js';

const API = 'https://www.googleapis.com/calendar/v3';

export class CalendarError extends Error {
  constructor(status, body) { super(`calendar ${status}: ${body?.error?.message ?? ''}`.trim()); this.status = status; this.body = body; }
}

const enc = encodeURIComponent;

export class Calendar {
  /** @param {{accessToken: () => Promise<string>, fetchImpl?: typeof fetch}} o */
  constructor({ accessToken, fetchImpl = fetch }) { Object.assign(this, { accessToken, fetchImpl }); }

  async call(method, path, { query, body, headers = {} } = {}) {
    const q = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))}` : '';
    const res = await this.fetchImpl(`${API}${path}${q}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new CalendarError(res.status, json);
    return json;
  }

  /**
   * events.list with singleEvents=true, all pages. With syncToken, timeMin/timeMax are not sent (Google
   * rejects them together). A 410 (sync token expired) surfaces as CalendarError status 410.
   */
  async listEvents(calendarId, { syncToken, timeMin, timeMax, showDeleted } = {}) {
    const items = []; let pageToken; let nextSyncToken = null;
    do {
      const query = syncToken
        ? { singleEvents: true, syncToken, pageToken }
        : { singleEvents: true, timeMin, timeMax, showDeleted, maxResults: 250, pageToken };
      const r = await this.call('GET', `/calendars/${enc(calendarId)}/events`, { query });
      items.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
      nextSyncToken = r.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
    return { items, nextSyncToken };
  }

  getEvent(calendarId, eventId) { return this.call('GET', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`); }

  insertEvent(calendarId, event, { sendUpdates = 'none', conference = false } = {}) {
    return this.call('POST', `/calendars/${enc(calendarId)}/events`, {
      query: { sendUpdates, ...(conference ? { conferenceDataVersion: 1 } : {}) }, body: event,
    });
  }

  /** Patch guarded by the event's etag (If-Match): a hand edit in Google makes this fail with 412. */
  patchEvent(calendarId, eventId, patch, { etag, sendUpdates = 'none', conference = false } = {}) {
    return this.call('PATCH', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, {
      query: { sendUpdates, ...(conference ? { conferenceDataVersion: 1 } : {}) }, body: patch,
      headers: etag ? { 'if-match': etag } : {},
    });
  }

  deleteEvent(calendarId, eventId, { etag, sendUpdates = 'none' } = {}) {
    return this.call('DELETE', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, {
      query: { sendUpdates }, headers: etag ? { 'if-match': etag } : {},
    });
  }

  /** Busy intervals per calendar id: { [id]: { busy: [{start, end}], errors? } }. */
  async freeBusy({ timeMin, timeMax, ids, timeZone }) {
    const r = await this.call('POST', '/freeBusy', { body: { timeMin, timeMax, timeZone, items: ids.map((id) => ({ id })) } });
    return r.calendars ?? {};
  }

  insertCalendar({ summary, description, timeZone }) {
    return this.call('POST', '/calendars', { body: { summary, description, timeZone } });
  }

  /** Only bin/calendar-release.js calls this, after checking the calendar holds no untagged event. */
  deleteCalendar(calendarId) { return this.call('DELETE', `/calendars/${enc(calendarId)}`); }

  async calendarList() {
    const items = []; let pageToken;
    do {
      const r = await this.call('GET', '/users/me/calendarList', { query: { pageToken } });
      items.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return items;
  }

  insertAcl(calendarId, { role, email }) {
    return this.call('POST', `/calendars/${enc(calendarId)}/acl`, { query: { sendNotifications: false }, body: { role, scope: { type: 'user', value: email } } });
  }
}

/** Access-token function for a per-mailbox calendar consent (calendar_token_enc), refreshed as needed. */
export function perMailboxToken(mailbox, config, { fetchImpl = fetch, now = Date.now } = {}) {
  let cached = null;
  return async () => {
    if (cached && now() < cached.expiresAt) return cached.token;
    const t = await refreshAccessToken({ ...tokenFor(mailbox, 'calendar', config), fetchImpl });
    cached = { token: t.access_token, expiresAt: now() + ((t.expires_in ?? 3600) - 60) * 1000 };
    return cached.token;
  };
}

/**
 * The calendar client for a mailbox. delegated businesses use the service account (saTokens, whose
 * allowlist check runs on every token); per_mailbox businesses use the mailbox's own calendar consent.
 */
export function calendarFor(mailbox, { db, config, saTokens, fetchImpl = fetch }) {
  const biz = db.prepare('SELECT calendar_access FROM businesses WHERE id = ?').get(mailbox.business_id);
  if (!biz) throw new Error('mailbox has no business');
  if (biz.calendar_access === 'delegated') {
    if (!saTokens) throw new Error('service account not configured');
    return new Calendar({ accessToken: () => saTokens.accessToken(mailbox.address), fetchImpl });
  }
  return new Calendar({ accessToken: perMailboxToken(mailbox, config, { fetchImpl }), fetchImpl });
}

// --- The shared 調整中 calendar (plan step 5, D28, D43, D51, D52) ---------------------------------------

export class HoldCalendarError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

/** Hidden marker in the calendar description, so a reinstall finds our calendar and never someone else's. */
export const holdCalendarTag = (businessId, { shadow = false } = {}) => `[tobiraInbox:${shadow ? 'shadow' : 'hold'}:${businessId}]`;
export const holdCalendarName = (businessName, { shadow = false } = {}) => `${businessName} 調整中${shadow ? ' (test)' : ''}`;
/** Title of a hold event (D7). */
export const holdTitle = (counterpart) => `仮: ${String(counterpart ?? '').trim() || '調整中'}`;

/**
 * The business's 調整中 (or, with shadow, its test) calendar, acting only as
 * hold_calendar_owner_mailbox_id. Finds it by the stored id, else in the owner's calendarList by name
 * and tag, else creates it in the business timezone. NULL owner, or an owner that is not a connected
 * mailbox of the business, refuses (fail closed: no calendar on anyone else's account).
 * clientFor(mailbox) returns a Calendar; it defaults to calendarFor.
 */
export async function ensureHoldCalendar({ db, businessId, shadow = false, clientFor }) {
  const biz = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!biz) throw new HoldCalendarError('no_business');
  if (!biz.hold_calendar_owner_mailbox_id) throw new HoldCalendarError('no_owner', 'hold_calendar_owner_mailbox_id is not set');
  const owner = db.prepare("SELECT * FROM mailboxes WHERE id = ? AND business_id = ? AND status = 'connected'").get(biz.hold_calendar_owner_mailbox_id, businessId);
  if (!owner) throw new HoldCalendarError('owner_unavailable', 'the hold calendar owner is not a connected mailbox of this business');
  const cal = clientFor(owner);
  const column = shadow ? 'shadow_calendar_id' : 'hold_calendar_id';
  const tag = holdCalendarTag(businessId, { shadow });
  const summary = holdCalendarName(biz.name, { shadow });
  const list = await cal.calendarList();
  const store = (id) => db.prepare(`UPDATE businesses SET ${column} = ? WHERE id = ?`).run(id, businessId);

  if (biz[column] && list.some((c) => c.id === biz[column])) return { id: biz[column], created: false, owner };
  const found = list.find((c) => c.summary === summary && String(c.description ?? '').includes(tag));
  if (found) { store(found.id); return { id: found.id, created: false, owner }; }
  const made = await cal.insertCalendar({ summary, description: `TobirAInbox ${tag}`, timeZone: biz.timezone || 'Asia/Tokyo' });
  store(made.id);
  db.prepare("INSERT INTO audit_log (business_id, action, target) VALUES (?, 'hold_calendar_created', ?)").run(businessId, made.id);
  return { id: made.id, created: true, owner };
}

/**
 * Shares the calendar as writer with every other connected mailbox of the business (D51). If Google
 * refuses the ACL write (calendar.app.created may not allow it), reports aclDenied and the owner shares
 * once by hand (§6.5). Acts as the owner only.
 */
export async function shareHoldCalendar({ db, businessId, calendarId, owner, clientFor }) {
  const cal = clientFor(owner);
  const others = db.prepare("SELECT address FROM mailboxes WHERE business_id = ? AND status = 'connected' AND id != ? ORDER BY address").all(businessId, owner.id);
  const out = { shared: [], failed: [], aclDenied: false };
  for (const { address } of others) {
    try { await cal.insertAcl(calendarId, { role: 'writer', email: address }); out.shared.push(address); }
    catch (err) {
      if (err instanceof CalendarError && err.status === 403) { out.aclDenied = true; out.failed.push({ address, error: err.message }); break; }
      out.failed.push({ address, error: err.message });
    }
  }
  return out;
}
