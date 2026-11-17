// apps/server/src/outreach.js — cold-outreach follow-ups from the optional external CRM backend.
//
// CRM knows which outreach leads replied positively and are still unanswered, and which went quiet
// after our reply:  GET <CRM>/api/internal/brain/outreach-followups  (same origin and bearer token as
// COCKPIT_EVENTS_URL). The worker reads it for businesses with report_to_cockpit and stamps the latest
// thread whose counterpart is the lead's contact_email, in any connected mailbox of the business. Leads
// with no such thread are kept in outreach_leads so they can still be listed. Nothing here sends mail:
// a CRM draft becomes an ordinary Inbox draft that a person reviews and sends.
import { findBlanks, parseFrom } from '@tobira-inbox/engine';
import { Store } from './store.js';
import { emit } from './cockpit-outbox.js';

export const BUCKETS = ['unanswered_positive', 'gone_quiet'];
export const OUTCOMES = ['meeting_booked', 'proposal_sent', 'won', 'lost'];
export const COCKPIT_DRAFT_NOTE = 'Cockpit の下書き';
const WE_WROTE_LAST = ['sent', 'waiting', 'done'];
export const FOLLOWUP_AFTER_DAYS = 5;

export function followupsUrl(eventsUrl) {
  if (!eventsUrl) return '';
  try { return `${new URL(eventsUrl).origin}/api/internal/brain/outreach-followups`; } catch { return ''; }
}

const clean = (lead) => {
  const email = String(lead?.contact_email ?? '').trim().toLowerCase();
  if (!lead?.lead_id || !email.includes('@') || !BUCKETS.includes(lead.bucket)) return null;
  const days = Number.isFinite(Number(lead.days_quiet)) ? Math.max(0, Math.round(Number(lead.days_quiet))) : null;
  const d = lead.cockpit_draft && typeof lead.cockpit_draft.body === 'string' && lead.cockpit_draft.body.trim()
    ? { subject: String(lead.cockpit_draft.subject ?? '').slice(0, 300), body: lead.cockpit_draft.body.slice(0, 20000) } : null;
  return {
    leadId: String(lead.lead_id), company: lead.company_name ? String(lead.company_name).slice(0, 200) : null, email, bucket: lead.bucket,
    positiveAt: lead.positive_reply_at ?? null, lastActivityAt: lead.last_activity_at ?? null, days, draft: d,
  };
};

/**
 * Apply one feed to one business: stamp matching threads, clear stamps no longer in the feed, keep the
 * unmatched leads, seed CRM drafts. Pure database work (the fetch is in syncOutreach) so tests can call it.
 */
export function applyFeed(db, businessId, leads, { now = new Date() } = {}) {
  const at = now.toISOString();
  const store = new Store(db, businessId);
  const threads = db.prepare(`SELECT t.id, t.status, t.cache_from, t.last_message_at, t.last_message_id, t.cockpit_lead_id FROM threads t
      JOIN mailboxes m ON m.id = t.mailbox_id
      WHERE t.business_id = ? AND m.status = 'connected' AND t.status != 'ignored'`).all(businessId);
  const byEmail = new Map();
  for (const t of threads) {
    const e = parseFrom(t.cache_from ?? '');
    if (!e) continue;
    const cur = byEmail.get(e);
    if (!cur || String(t.last_message_at ?? '') > String(cur.last_message_at ?? '')) byEmail.set(e, t);
  }
  const out = { stamped: 0, cleared: 0, unmatched: 0, seeded: 0, needsDraft: [] };
  db.transaction(() => {
    const stamped = new Set();
    db.prepare('DELETE FROM outreach_leads WHERE business_id = ?').run(businessId);
    for (const raw of leads ?? []) {
      const l = clean(raw); if (!l) continue;
      const t = byEmail.get(l.email);
      if (!t) {
        db.prepare(`INSERT OR REPLACE INTO outreach_leads (business_id, lead_id, company_name, contact_email, bucket, positive_reply_at, last_activity_at, days_quiet,
            draft_subject, draft_body, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(businessId, l.leadId, l.company, l.email, l.bucket, l.positiveAt, l.lastActivityAt, l.days, l.draft?.subject ?? null, l.draft?.body ?? null, at);
        out.unmatched += 1; continue;
      }
      if (stamped.has(t.id)) continue; // two leads on one address: the first wins
      stamped.add(t.id);
      // CRM cannot see replies sent from Gmail or Inbox. When our side wrote last in this thread
      // (status sent/waiting/done), the lead is not waiting on us: it is a follow-up once it has been quiet
      // for FOLLOWUP_AFTER_DAYS, and in neither list before that.
      if (l.bucket === 'unanswered_positive' && WE_WROTE_LAST.includes(t.status)) {
        const quiet = t.last_message_at ? Math.floor((now - new Date(t.last_message_at)) / 86400000) : null;
        l.bucket = quiet != null && quiet >= FOLLOWUP_AFTER_DAYS ? 'gone_quiet' : null;
        l.days = quiet;
        db.prepare("UPDATE drafts SET status = 'discarded' WHERE thread_id = ? AND status = 'open' AND note = ?").run(t.id, COCKPIT_DRAFT_NOTE);
      }
      db.prepare(`UPDATE threads SET cockpit_lead_id = ?, outreach_bucket = ?, outreach_days_quiet = ?, outreach_positive_reply_at = ?, outreach_synced_at = ?
          WHERE id = ?`).run(l.leadId, l.bucket, l.days, l.positiveAt, at, t.id);
      out.stamped += 1;
      // A positive reply with no Inbox draft gets CRM's draft, once; a person reviews and sends it.
      if (l.bucket === 'unanswered_positive' && l.draft) {
        const has = db.prepare("SELECT 1 FROM drafts WHERE thread_id = ? AND (status IN ('open','queued') OR note = ?)").get(t.id, COCKPIT_DRAFT_NOTE);
        if (!has) {
          const id = store.saveDraft({ threadId: t.id, bodyText: l.draft.body, blanks: findBlanks(l.draft.body).map((b) => b.text), model: 'cockpit', createdBy: 'ai', note: COCKPIT_DRAFT_NOTE });
          // Counts as the draft for the latest message, so the auto-drafter does not write a second one.
          if (t.last_message_id) db.prepare('UPDATE drafts SET for_message_id = ? WHERE id = ?').run(t.last_message_id, id);
          out.seeded += 1;
        }
      } else if (l.bucket === 'unanswered_positive' && t.last_message_id) {
        // No CRM draft (CRM cancels drafts of retired leads): the normal AI draft, unless one exists or is
        // already being tried for this message.
        const has = db.prepare("SELECT 1 FROM drafts WHERE thread_id = ? AND (status IN ('open','queued') OR for_message_id = ?)").get(t.id, t.last_message_id)
          ?? db.prepare('SELECT 1 FROM draft_attempts WHERE thread_id = ? AND message_id = ?').get(t.id, t.last_message_id);
        if (!has) out.needsDraft.push(t.id);
      }
    }
    // Stale stamps: a thread whose lead left the feed (answered, closed in CRM) or moved to a newer thread.
    for (const r of db.prepare('SELECT id FROM threads WHERE business_id = ? AND outreach_bucket IS NOT NULL').all(businessId)) {
      if (stamped.has(r.id)) continue;
      db.prepare('UPDATE threads SET outreach_bucket = NULL, outreach_days_quiet = NULL, outreach_positive_reply_at = NULL, outreach_synced_at = ? WHERE id = ?').run(at, r.id);
      out.cleared += 1;
    }
  })();
  return out;
}

/** Fetch the feed once and apply it to every business that reports to cockpit. Inert until configured. */
export async function syncOutreach(db, config, { fetchImpl = fetch, now = new Date(), draftThread } = {}) {
  let url = followupsUrl(config.cockpitEventsUrl);
  if (url && config.cockpitTenant) url += `?tenant=${encodeURIComponent(config.cockpitTenant)}`;
  if (!url || !config.cockpitEventsToken) return { skipped: 'not configured' };
  const businesses = db.prepare("SELECT id FROM businesses WHERE report_to_cockpit = 1 AND status = 'active'").all();
  if (!businesses.length) return { skipped: 'no business reports to cockpit' };
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${config.cockpitEventsToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`cockpit outreach-followups ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.leads)) throw new Error('cockpit outreach-followups: no leads array');
  const out = businesses.map((b) => ({ id: b.id, ...applyFeed(db, b.id, body.leads, { now }) }));
  // AI drafts for positive replies CRM sent no draft for (draftThread is the worker's normal on-request draft).
  for (const b of out) {
    b.drafted = 0;
    for (const id of b.needsDraft) {
      if (!draftThread) break;
      try { if ((await draftThread(id))?.status === 'drafted') b.drafted += 1; } catch { /* draft_attempts records it; retried there */ }
    }
    b.needsDraft = b.needsDraft.length;
  }
  return { businesses: out };
}

/** 打ち合わせ確定 / 提案送付 / 受注 / 失注 on a thread with a CRM lead: stored here, sent to CRM via the outbox. */
export function recordOutcome(db, { businessId, threadId, outcome, userId, now = new Date() }) {
  if (!OUTCOMES.includes(outcome)) return { ok: false, code: 400, error: 'bad outcome' };
  const t = db.prepare(`SELECT t.*, m.address FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id WHERE t.id = ? AND t.business_id = ?`).get(threadId, businessId);
  if (!t) return { ok: false, code: 404, error: 'not found' };
  if (!t.cockpit_lead_id) return { ok: false, code: 409, error: 'not an outreach lead' };
  const at = now.toISOString();
  const contact = parseFrom(t.cache_from ?? '') || null;
  db.transaction(() => {
    db.prepare('UPDATE threads SET outreach_outcome = ?, outreach_outcome_at = ? WHERE id = ?').run(outcome, at, t.id);
    emit(db, { businessId, type: 'outcome', mailbox: t.address, thread: t.gmail_thread_id,
      extra: { lead_id: t.cockpit_lead_id, contact_email: contact, gmail_thread_id: t.gmail_thread_id, outcome } });
    new Store(db, businessId).audit(userId, 'outreach_outcome', t.id, { outcome });
  })();
  return { ok: true, outcome, at };
}
