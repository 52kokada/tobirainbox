// apps/server/src/cockpit-check.js — pre-send suppression check against the optional external CRM backend.
//
// CRM owns suppression (opt-outs, bounces, policy refusals from every Tobira
// mailbox and outreach line); Inbox keeps no list of its own. Before a business
// that reports to CRM sends, ask CRM's read-only lead-context route:
//   GET /api/internal/brain/inbox-lead-context?mailbox=&to_email=&gmail_thread_id=
//   → { send: { allowed, reason }, ... }
// A suppressed recipient is refused for good (SendRefused, alert). If CRM
// cannot answer, the send is held and retried; it never goes out unchecked
// (a deliberate fail-closed choice). Businesses that do not report to CRM skip the check.
import { SendRefused } from './send-queue.js';

export function leadContextUrl(eventsUrl) {
  if (!eventsUrl) return '';
  return eventsUrl.replace(/\/inbox-events\/?$/, '/inbox-lead-context');
}

export async function cockpitSendCheck(db, config, { mailbox, thread, toEmail }, { fetchImpl = fetch } = {}) {
  const b = db.prepare('SELECT report_to_cockpit FROM businesses WHERE id = ?').get(mailbox.business_id);
  if (!b?.report_to_cockpit) return { checked: false };
  const base = leadContextUrl(config.cockpitEventsUrl);
  if (!base || !config.cockpitEventsToken) throw new Error('cockpit suppression check not configured; send held');
  const q = new URLSearchParams({ mailbox: mailbox.address, to_email: toEmail });
  if (thread?.gmail_thread_id) q.set('gmail_thread_id', thread.gmail_thread_id);
  let res;
  try {
    res = await fetchImpl(`${base}?${q}`, { headers: { authorization: `Bearer ${config.cockpitEventsToken}` }, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`cockpit unreachable (${err.message}); send held`);
  }
  if (!res.ok) throw new Error(`cockpit check failed (${res.status}); send held`);
  const body = await res.json();
  if (body?.send?.allowed === false) {
    throw new SendRefused('recipient_suppressed', `${toEmail} は配信停止の対象です（Cockpit）。このメールは送信しませんでした。`);
  }
  if (body?.send?.allowed !== true) throw new Error('cockpit gave no send decision; send held');
  return { checked: true, lead: body.lead ?? null };
}
