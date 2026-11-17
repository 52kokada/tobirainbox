// apps/server/src/store.js — the only way the app reads or writes business data.
// A Store is bound to one business; every statement filters on business_id, so
// one business can never read or change another's rows.
import { randomUUID } from 'node:crypto';
import { effectiveLabels } from '@tobira-inbox/engine';

export const newId = () => randomUUID();

export class Store {
  /** @param {import('better-sqlite3').Database} db  @param {string} businessId */
  constructor(db, businessId) {
    if (!businessId) throw new Error('Store requires a businessId');
    this.db = db;
    this.businessId = businessId;
  }

  business() {
    return this.db.prepare('SELECT * FROM businesses WHERE id = ?').get(this.businessId) ?? null;
  }

  user(userId) {
    return this.db.prepare('SELECT * FROM users WHERE id = ? AND business_id = ?').get(userId, this.businessId) ?? null;
  }

  mailboxes() {
    return this.db.prepare('SELECT * FROM mailboxes WHERE business_id = ? ORDER BY address').all(this.businessId);
  }

  mailbox(id) {
    return this.db.prepare('SELECT * FROM mailboxes WHERE id = ? AND business_id = ?').get(id, this.businessId) ?? null;
  }

  labels() {
    const rows = this.db.prepare('SELECT * FROM label_overrides WHERE business_id = ?').all(this.businessId);
    return effectiveLabels(rows.map((r) => ({
      key: r.key, ja: r.ja ?? undefined, en: r.en ?? undefined, hint: r.hint ?? undefined,
      hidden: r.hidden == null ? undefined : Boolean(r.hidden),
      autoDraft: r.auto_draft == null ? undefined : Boolean(r.auto_draft),
    })));
  }

  facts() {
    return this.db.prepare('SELECT key, value, source FROM facts WHERE business_id = ? ORDER BY key').all(this.businessId);
  }

  setFact(key, value, source = 'owner') {
    this.db.prepare(`INSERT INTO facts (id, business_id, key, value, source) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (business_id, key) DO UPDATE SET value = excluded.value, source = excluded.source,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(newId(), this.businessId, key, value, source);
  }

  playbook(labelKey = null) {
    return this.db.prepare(`SELECT id, text, label_key, phase FROM playbook_rules
      WHERE business_id = ? AND status = 'active' AND (label_key IS NULL OR label_key = ?) ORDER BY created_at`)
      .all(this.businessId, labelKey);
  }

  thread(id) {
    return this.db.prepare('SELECT * FROM threads WHERE id = ? AND business_id = ?').get(id, this.businessId) ?? null;
  }

  /** Triage list: newest first, optional filters. */
  triage({ status, labelKey, mailboxId, assignee, limit = 100 } = {}) {
    const where = ['business_id = ?'];
    const args = [this.businessId];
    if (status) { where.push('status = ?'); args.push(status); } else { where.push("status NOT IN ('done','ignored')"); }
    if (labelKey) { where.push('label_key = ?'); args.push(labelKey); }
    if (mailboxId) { where.push('mailbox_id = ?'); args.push(mailboxId); }
    if (assignee) { where.push('assignee_user_id = ?'); args.push(assignee); }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM threads WHERE ${where.join(' AND ')} ORDER BY last_message_at DESC LIMIT ?`).all(...args);
  }

  draft(id) {
    return this.db.prepare('SELECT * FROM drafts WHERE id = ? AND business_id = ?').get(id, this.businessId) ?? null;
  }

  latestDraft(threadId) {
    return this.db.prepare(`SELECT * FROM drafts WHERE thread_id = ? AND business_id = ? AND status != 'discarded'
      ORDER BY version DESC LIMIT 1`).get(threadId, this.businessId) ?? null;
  }

  /** Save a new draft version (AI or a person's edit). */
  saveDraft({ threadId, bodyText, blanks = [], model = null, costUsd = 0, createdBy, note = null }) {
    if (!this.thread(threadId)) throw new Error('thread not found');
    return this.db.transaction(() => {
      const v = (this.db.prepare('SELECT MAX(version) AS v FROM drafts WHERE thread_id = ?').get(threadId)?.v ?? 0) + 1;
      const id = newId();
      // A person's edit of an open confirmation or correction draft stays that meeting's draft (step 15: the
      // invite follows the version actually sent). AI redrafts discard the open draft first, so they never inherit.
      const prev = createdBy === 'user'
        ? this.db.prepare("SELECT meeting_id, meeting_purpose FROM drafts WHERE thread_id = ? AND status = 'open' AND meeting_id IS NOT NULL ORDER BY version DESC LIMIT 1").get(threadId)
        : null;
      this.db.prepare(`INSERT INTO drafts (id, business_id, thread_id, version, body_text, blanks_json, model, cost_usd, created_by, note, meeting_id, meeting_purpose)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, this.businessId, threadId, v, bodyText, JSON.stringify(blanks), model, costUsd, createdBy, note ? String(note).slice(0, 120) : null,
        prev?.meeting_id ?? null, prev?.meeting_purpose ?? null);
      this.db.prepare(`UPDATE threads SET status = CASE WHEN status = 'new' THEN 'drafted' ELSE status END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND business_id = ?`).run(threadId, this.businessId);
      return id;
    })();
  }

  audit(userId, action, target = null, detail = null) {
    this.db.prepare('INSERT INTO audit_log (business_id, user_id, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .run(this.businessId, userId, action, target, detail == null ? null : JSON.stringify(detail));
  }

  logUsage({ operation, model, tokensIn = 0, tokensOut = 0, costUsd = 0, mailboxId = null, threadId = null }) {
    this.db.prepare("INSERT INTO ai_usage (business_id, mailbox_id, thread_id, operation, model, tokens_in, tokens_out, cost_usd, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok')")
      .run(this.businessId, mailboxId, threadId, operation, model, tokensIn, tokensOut, costUsd);
  }

  /** Spend summary for this business: today, last 7 days, this month (UTC), by operation and model. */
  spend() {
    const q = (since) => this.db.prepare(`SELECT operation, model, COUNT(*) AS calls, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
        SUM(cache_read_tokens) AS cache_read, ROUND(SUM(cost_usd), 4) AS usd
      FROM ai_usage WHERE business_id = ? AND at >= ? GROUP BY operation, model ORDER BY usd DESC`).all(this.businessId, since);
    const now = new Date();
    const day = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
    const week = new Date(now.getTime() - 7 * 86400_000).toISOString();
    const month = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;
    const total = (rows) => Math.round(rows.reduce((a, r) => a + (r.usd ?? 0), 0) * 10000) / 10000;
    const t = q(day); const w = q(week); const m = q(month);
    return { today: { usd: total(t), rows: t }, last7: { usd: total(w), rows: w }, month: { usd: total(m), rows: m },
      capUsd: this.business()?.ai_daily_cap_usd ?? null };
  }

  // Calendar (plan step 3). Every accessor is scoped to this business; rows of another business are never returned.

  /** Calendar settings of this business, with free-slot hours parsed. */
  calendarSettings() {
    const b = this.business();
    if (!b) return null;
    return {
      mode: b.calendar_mode, timezone: b.timezone, access: b.calendar_access, holdCalendarId: b.hold_calendar_id,
      holdCalendarOwnerMailboxId: b.hold_calendar_owner_mailbox_id, shadowCalendarId: b.shadow_calendar_id,
      holdSilenceDays: b.hold_silence_days, freeSlotHours: parseFreeSlotHours(b.free_slot_hours) ?? DEFAULT_FREE_SLOT_HOURS,
    };
  }

  suggestion(id) { return this.#one('suggestions', id); }
  suggestions({ state, from, to } = {}) { return this.#range('suggestions', { state, from, to }); }
  meeting(id) { return this.#one('meetings', id); }
  meetings({ state, from, to } = {}) { return this.#range('meetings', { state, from, to }); }
  hold(id) { return this.#one('holds', id); }
  holds({ state } = {}) {
    return this.db.prepare(`SELECT * FROM holds WHERE business_id = ?${state ? ' AND state = ?' : ''} ORDER BY expires_at`)
      .all(this.businessId, ...(state ? [state] : []));
  }
  calendarEvents({ from, to } = {}) { return this.#range('calendar_events', { from, to }); }
  calendarSync() { return this.db.prepare('SELECT * FROM calendar_sync WHERE business_id = ? ORDER BY google_calendar_id').all(this.businessId); }
  calendarWrites({ status } = {}) {
    return this.db.prepare(`SELECT * FROM calendar_writes WHERE business_id = ?${status ? ' AND status = ?' : ''} ORDER BY created_at`)
      .all(this.businessId, ...(status ? [status] : []));
  }

  #one(table, id) {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND business_id = ?`).get(id, this.businessId) ?? null;
  }

  /** Rows whose start_utc falls in [from, to), optionally in one state. */
  #range(table, { state, from, to }) {
    const where = ['business_id = ?']; const args = [this.businessId];
    if (state) { where.push('state = ?'); args.push(state); }
    if (from) { where.push('start_utc >= ?'); args.push(from); }
    if (to) { where.push('start_utc < ?'); args.push(to); }
    return this.db.prepare(`SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY start_utc`).all(...args);
  }
}

export const DEFAULT_FREE_SLOT_HOURS = Object.freeze({ days: [1, 2, 3, 4, 5], from: '10:00', to: '18:00' });

/** True for an IANA zone this runtime knows (e.g. 'Asia/Tokyo'). */
export function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Free-slot hours (D49): { days: [0-6, 0 = Sunday], from: 'HH:MM', to: 'HH:MM' } in the business timezone.
 * Accepts an object or its JSON; returns a clean copy, or null when it is not valid.
 */
export function parseFreeSlotHours(v) {
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { return null; } }
  if (!o || typeof o !== 'object' || !Array.isArray(o.days)) return null;
  const days = [...new Set(o.days.map(Number))].sort((a, b) => a - b);
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return null;
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hm.test(o.from ?? '') || !hm.test(o.to ?? '') || o.from >= o.to) return null;
  return { days, from: o.from, to: o.to };
}
