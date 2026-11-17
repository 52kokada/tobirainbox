// apps/server/src/calendar-view.js — what a viewer may see of cached calendar events (D16, D34, D39).
// A private event on a calendar that is not the viewer's own shows only start, end and busy. "Own" is
// the mailbox whose address equals the viewer's login email (D39); with no such mailbox nothing is own
// (plan §8.3). Enforced here, server-side, so private fields never reach another member's or a partner's JSON.

const PRIVATE = new Set(['private', 'confidential']);

/** The viewer's own mailbox id in this business, or null. */
export function ownMailboxId(db, businessId, email) {
  if (!email) return null;
  const r = db.prepare('SELECT id FROM mailboxes WHERE business_id = ? AND lower(address) = ?').get(businessId, String(email).toLowerCase());
  return r?.id ?? null;
}

/** viewer: { ownMailboxId }. Rows are calendar_events rows of one business. */
export function eventsForViewer(rows, viewer = {}) {
  return rows.map((r) => {
    const own = viewer.ownMailboxId != null && r.mailbox_id === viewer.ownMailboxId;
    if (PRIVATE.has(r.visibility) && !own) {
      return { id: r.id, mailbox_id: r.mailbox_id, google_calendar_id: r.google_calendar_id, start_utc: r.start_utc, end_utc: r.end_utc, all_day: r.all_day, busy: true };
    }
    return {
      id: r.id, mailbox_id: r.mailbox_id, google_calendar_id: r.google_calendar_id, google_event_id: r.google_event_id,
      start_utc: r.start_utc, end_utc: r.end_utc, all_day: r.all_day, title: r.title, location: r.location, meet_url: r.meet_url,
      visibility: r.visibility, ours_tag: r.ours_tag, status: r.status, busy: false,
    };
  });
}
