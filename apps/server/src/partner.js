// apps/server/src/partner.js — D8 partner role: limited access the shop agrees to.
// Owner and staff see every mailbox of their business. A partner sees only the mailboxes an
// owner granted (partner_mailboxes), may send only where can_send is set, and never sees
// company settings, the playbook, facts, the team, alerts, billing or exports.

/** @returns {null | {mailboxIds: Set<string>, canSend: Set<string>}} null = no limit (owner/staff). */
export function accessScope(db, user) {
  if (!user || user.role !== 'partner') return null;
  const rows = db.prepare('SELECT mailbox_id, can_send FROM partner_mailboxes WHERE user_id = ? AND business_id = ?').all(user.id, user.business_id);
  return { mailboxIds: new Set(rows.map((r) => r.mailbox_id)), canSend: new Set(rows.filter((r) => r.can_send).map((r) => r.mailbox_id)) };
}

/** SQL fragment + params limiting `alias.mailbox_id` to the scope ('' when unlimited). */
export function mailboxFilter(scope, alias = 't') {
  if (!scope) return { sql: '', args: [] };
  const ids = [...scope.mailboxIds];
  if (!ids.length) return { sql: ' AND 0', args: [] };
  return { sql: ` AND ${alias}.mailbox_id IN (${ids.map(() => '?').join(',')})`, args: ids };
}

export const canSee = (scope, mailboxId) => !scope || scope.mailboxIds.has(mailboxId);
export const canSendFrom = (scope, mailboxId) => !scope || scope.canSend.has(mailboxId);

/** The thread a route's :id points at (thread, draft or send), for the scope check. */
export function threadIdFor(db, businessId, url, id) {
  if (!id) return null;
  if (url.startsWith('/api/threads/')) return id;
  if (url.startsWith('/api/drafts/')) return db.prepare('SELECT thread_id FROM drafts WHERE id = ? AND business_id = ?').get(id, businessId)?.thread_id ?? '';
  if (url.startsWith('/api/sends/')) {
    return db.prepare('SELECT d.thread_id FROM sends s JOIN drafts d ON d.id = s.draft_id WHERE s.id = ? AND s.business_id = ?').get(id, businessId)?.thread_id ?? '';
  }
  return null;
}

/** Owner sets one partner's grants: [{mailboxId, canSend}] replaces what was there. */
export function setPartnerAccess(db, { businessId, userId, grants, grantedBy }) {
  const valid = new Set(db.prepare('SELECT id FROM mailboxes WHERE business_id = ?').all(businessId).map((m) => m.id));
  db.transaction(() => {
    db.prepare('DELETE FROM partner_mailboxes WHERE user_id = ? AND business_id = ?').run(userId, businessId);
    for (const g of grants ?? []) {
      if (!valid.has(g?.mailboxId)) continue;
      db.prepare('INSERT OR REPLACE INTO partner_mailboxes (user_id, mailbox_id, business_id, can_send, granted_by) VALUES (?, ?, ?, ?, ?)')
        .run(userId, g.mailboxId, businessId, g.canSend ? 1 : 0, grantedBy ?? null);
    }
  })();
}

export function partnerAccessList(db, businessId, userId) {
  return db.prepare('SELECT mailbox_id AS mailboxId, can_send AS canSend FROM partner_mailboxes WHERE user_id = ? AND business_id = ?')
    .all(userId, businessId).map((r) => ({ mailboxId: r.mailboxId, canSend: Boolean(r.canSend) }));
}
