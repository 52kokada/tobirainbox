// apps/server/src/routes/settings.js — company settings and team (Phase 5).
// Reading: any signed-in member. Changing: owners only. Always scoped to the
// signed-in company.
import { BUILT_IN_LABELS, LABEL_KEYS } from '@tobira-inbox/engine';
import { newId } from '../store.js';
import { currentSession } from '../auth.js';
import { Store, validTimezone, parseFreeSlotHours } from '../store.js';
import { setPartnerAccess, partnerAccessList } from '../partner.js';
const PHASE_KEYS = ['first', 'sample', 'deal', 'active', 'after'];

const INTAKE_KINDS = ['exclude_sender', 'exclude_domain', 'exclude_gmail_label', 'include_only_gmail_label'];
// Calendar settings only Tobira staff change, through the ADMIN_TOKEN route, until Tobira is switched on.
const ADMIN_ONLY_CALENDAR_KEYS = ['calendarMode', 'calendarAccess', 'holdCalendarOwnerMailboxId', 'shadowCalendarId', 'holdSilenceDays', 'holdCalendarId'];
const str = (v, max = 4000) => String(v ?? '').trim().slice(0, max);

export function registerSettingsRoutes(app, { db, config }) {
  const member = (req, reply) => {
    const s = currentSession(db, req, config.masterKey);
    if (!s) { reply.code(401).send({ error: 'sign in required' }); return null; }
    // D8 partner: company settings, playbook, facts and team are not theirs to see.
    if (s.user.role === 'partner') { reply.code(403).send({ error: 'not for partners' }); return null; }
    return { ...s, store: new Store(db, s.business.id) };
  };
  const owner = (req, reply) => {
    const s = member(req, reply);
    if (!s) return null;
    if (s.user.role !== 'owner') { reply.code(403).send({ error: 'owner only' }); return null; }
    return s;
  };
  const audit = (s, action, target, detail) => s.store.audit(s.user.id, action, target, detail);

  app.get('/api/settings', async (req, reply) => {
    const s = member(req, reply); if (!s) return;
    const b = s.store.business();
    const overrides = new Set(db.prepare('SELECT key FROM label_overrides WHERE business_id = ?').all(b.id).map((r) => r.key));
    return {
      canEdit: s.user.role === 'owner',
      business: {
        name: b.name, undoSeconds: b.undo_seconds, plainText: Boolean(b.plain_text),
        dailyCapUsd: b.ai_daily_cap_usd, defaultDailyCapUsd: config.aiDailyCapUsd, sharedVoiceId: b.shared_voice_id,
        timezone: b.timezone,
      },
      // Owners edit timezone and freeSlotHours; the rest is shown read-only (set by Tobira staff).
      calendar: s.store.calendarSettings(),
      labels: s.store.labels().map((l) => ({ key: l.key, ja: l.ja, en: l.en, hidden: Boolean(l.hidden), autoDraft: Boolean(l.autoDraft), custom: Boolean(l.custom), changed: overrides.has(l.key) })),
      playbook: db.prepare('SELECT id, label_key AS label, text, source, status, phase FROM playbook_rules WHERE business_id = ? AND status != ? ORDER BY status DESC, created_at').all(b.id, 'rejected'),
      facts: s.store.facts(),
      voices: db.prepare('SELECT id, mailbox_address AS mailbox, full_name AS fullName, style, signature FROM voice_profiles WHERE business_id = ? ORDER BY mailbox_address').all(b.id),
      intake: db.prepare(`SELECT r.id, r.kind, r.value, m.address AS mailbox FROM intake_rules r LEFT JOIN mailboxes m ON m.id = r.mailbox_id WHERE r.business_id = ? ORDER BY r.kind, r.value`).all(b.id),
      // Removed members keep their row (audit trail) under a renamed email; they are not on the team.
      team: db.prepare("SELECT id, email, name, role, last_login_at AS lastLogin FROM users WHERE business_id = ? AND instr(email, '#removed-') = 0 ORDER BY role, email").all(b.id)
        .map((u) => (u.role === 'partner' ? { ...u, access: partnerAccessList(db, b.id, u.id) } : u)),
      mailboxes: s.store.mailboxes().map((m) => ({ id: m.id, address: m.address, mode: m.mode, status: m.status, lastError: m.last_error })),
      // What the sorter has learned from people: their label corrections (contact details already removed).
      learnings: db.prepare('SELECT id, from_label AS fromLabel, to_label AS toLabel, from_domain AS domain, subject_redacted AS subject, at FROM label_corrections WHERE business_id = ? ORDER BY at DESC LIMIT 50').all(b.id),
      learnedCount: db.prepare('SELECT COUNT(*) AS n FROM label_corrections WHERE business_id = ?').get(b.id).n,
      exampleCount: db.prepare('SELECT COUNT(*) AS n FROM examples WHERE business_id = ?').get(b.id).n,
    };
  });

  // Forget one learned correction, so the sorter no longer uses it as an example.
  app.delete('/api/settings/learnings/:id', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const r = db.prepare('DELETE FROM label_corrections WHERE id = ? AND business_id = ?').run(Number(req.params.id), s.business.id);
    if (!r.changes) return reply.code(404).send({ error: 'not found' });
    s.store.audit(s.user.id, 'learning_forgotten', String(req.params.id));
    return { ok: true };
  });

  app.put('/api/settings/business', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const b = req.body ?? {};
    const adminOnly = ADMIN_ONLY_CALENDAR_KEYS.filter((k) => b[k] !== undefined);
    if (adminOnly.length) return reply.code(403).send({ error: `${adminOnly.join(', ')}: set by Tobira staff` });
    const sets = []; const args = [];
    if (b.timezone != null) {
      if (!validTimezone(b.timezone)) return reply.code(400).send({ error: 'timezone must be an IANA zone such as Asia/Tokyo' });
      sets.push('timezone = ?'); args.push(b.timezone);
    }
    if (b.freeSlotHours != null) {
      const v = parseFreeSlotHours(b.freeSlotHours);
      if (!v) return reply.code(400).send({ error: 'freeSlotHours needs days 0-6 and from < to as HH:MM' });
      sets.push('free_slot_hours = ?'); args.push(JSON.stringify(v));
    }
    if (b.undoSeconds != null) {
      const v = Number(b.undoSeconds);
      if (!(v >= 5 && v <= 30)) return reply.code(400).send({ error: 'undoSeconds must be 5-30' });
      sets.push('undo_seconds = ?'); args.push(Math.round(v));
    }
    if (b.plainText != null) { sets.push('plain_text = ?'); args.push(b.plainText ? 1 : 0); }
    if (b.name != null) {
      const v = String(b.name).trim();
      if (!v || v.length > 80) return reply.code(400).send({ error: 'name must be 1-80 characters' });
      sets.push('name = ?'); args.push(v);
    }
    if (b.dailyCapUsd !== undefined) {
      const v = b.dailyCapUsd === null || b.dailyCapUsd === '' ? null : Number(b.dailyCapUsd);
      if (v !== null && !(v >= 0 && v <= 1000)) return reply.code(400).send({ error: 'dailyCapUsd must be 0-1000' });
      sets.push('ai_daily_cap_usd = ?'); args.push(v);
    }
    if (b.sharedVoiceId !== undefined) {
      const v = b.sharedVoiceId || null;
      if (v && !db.prepare('SELECT 1 FROM voice_profiles WHERE id = ? AND business_id = ?').get(v, s.business.id)) return reply.code(400).send({ error: 'unknown voice' });
      sets.push('shared_voice_id = ?'); args.push(v);
    }
    if (!sets.length) return { ok: true };
    db.prepare(`UPDATE businesses SET ${sets.join(', ')} WHERE id = ?`).run(...args, s.business.id);
    audit(s, 'settings_business', s.business.id, b);
    return { ok: true };
  });

  // Owners decide when a mailbox may send (試運転 → 送信可能) or pause it.
  app.put('/api/settings/mailboxes/:id', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const mode = String(req.body?.mode ?? '');
    if (!['shadow', 'live', 'paused'].includes(mode)) return reply.code(400).send({ error: 'bad mode' });
    const r = db.prepare('UPDATE mailboxes SET mode = ? WHERE id = ? AND business_id = ?').run(mode, req.params.id, s.business.id);
    if (!r.changes) return reply.code(404).send({ error: 'not found' });
    s.store.audit(s.user.id, `mailbox_${mode}`, req.params.id);
    return { ok: true };
  });

  app.put('/api/settings/labels/:key', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const key = str(req.params.key, 40);
    if (!/^[a-z0-9_]+$/.test(key)) return reply.code(400).send({ error: 'label key: a-z, 0-9, _' });
    if (key === 'unconfirmed' && req.body?.hidden) return reply.code(400).send({ error: '要確認 cannot be hidden' });
    const b = req.body ?? {};
    const isNew = !LABEL_KEYS.has(key) && !db.prepare('SELECT 1 FROM label_overrides WHERE business_id = ? AND key = ?').get(s.business.id, key);
    if (isNew && !str(b.ja)) return reply.code(400).send({ error: 'a new label needs a Japanese name' });
    db.prepare(`INSERT INTO label_overrides (business_id, key, ja, en, hint, hidden, auto_draft) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (business_id, key) DO UPDATE SET ja = COALESCE(excluded.ja, ja), en = COALESCE(excluded.en, en), hint = COALESCE(excluded.hint, hint),
        hidden = COALESCE(excluded.hidden, hidden), auto_draft = COALESCE(excluded.auto_draft, auto_draft)`)
      .run(s.business.id, key, str(b.ja, 40) || null, str(b.en, 40) || null, str(b.hint, 300) || null,
        b.hidden == null ? null : (b.hidden ? 1 : 0), b.autoDraft == null ? null : (b.autoDraft ? 1 : 0));
    audit(s, 'settings_label', key, b);
    return { ok: true };
  });

  app.post('/api/settings/playbook', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const text = str(req.body?.text, 1000);
    if (!text) return reply.code(400).send({ error: 'text required' });
    const label = req.body?.label ? str(req.body.label, 40) : null;
    const phase = PHASE_KEYS.includes(req.body?.phase) ? req.body.phase : null;
    const id = newId();
    db.prepare("INSERT INTO playbook_rules (id, business_id, label_key, text, source, status, phase) VALUES (?, ?, ?, ?, 'owner', 'active', ?)").run(id, s.business.id, label, text, phase);
    audit(s, 'playbook_add', id);
    return { id };
  });

  app.put('/api/settings/playbook/:id', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const b = req.body ?? {};
    const status = b.status && ['active', 'proposed', 'rejected'].includes(b.status) ? b.status : null;
    const phaseSet = b.phase !== undefined ? 1 : 0; const phase = PHASE_KEYS.includes(b.phase) ? b.phase : null;
    const r = db.prepare('UPDATE playbook_rules SET text = COALESCE(?, text), label_key = CASE WHEN ? THEN ? ELSE label_key END, status = COALESCE(?, status), phase = CASE WHEN ? THEN ? ELSE phase END WHERE id = ? AND business_id = ?')
      .run(b.text != null ? str(b.text, 1000) : null, b.label !== undefined ? 1 : 0, b.label || null, status, phaseSet, phase, req.params.id, s.business.id);
    if (!r.changes) return reply.code(404).send({ error: 'not found' });
    audit(s, 'playbook_edit', req.params.id, { status });
    return { ok: true };
  });

  app.delete('/api/settings/playbook/:id', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    // Kept as 'rejected' so the history of rules stays (never hard-deleted).
    const r = db.prepare("UPDATE playbook_rules SET status = 'rejected' WHERE id = ? AND business_id = ?").run(req.params.id, s.business.id);
    if (!r.changes) return reply.code(404).send({ error: 'not found' });
    audit(s, 'playbook_remove', req.params.id);
    return { ok: true };
  });

  app.put('/api/settings/facts', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const key = str(req.body?.key, 100); const value = str(req.body?.value, 2000);
    if (!key || !value) return reply.code(400).send({ error: 'key and value required' });
    s.store.setFact(key, value, 'owner');
    audit(s, 'fact_set', key);
    return { ok: true };
  });

  app.delete('/api/settings/facts', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const r = db.prepare('DELETE FROM facts WHERE business_id = ? AND key = ?').run(s.business.id, str(req.query?.key, 100));
    if (!r.changes) return reply.code(404).send({ error: 'not found' });
    audit(s, 'fact_remove', req.query?.key);
    return { ok: true };
  });

  app.put('/api/settings/voices/:id', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const b = req.body ?? {};
    const r = db.prepare('UPDATE voice_profiles SET full_name = COALESCE(?, full_name), style = COALESCE(?, style), signature = COALESCE(?, signature) WHERE id = ? AND business_id = ?')
      .run(b.fullName != null ? str(b.fullName, 100) : null, b.style != null ? str(b.style, 4000) : null, b.signature != null ? str(b.signature, 2000) : null, req.params.id, s.business.id);
    if (!r.changes) return reply.code(404).send({ error: 'not found' });
    audit(s, 'voice_edit', req.params.id);
    return { ok: true };
  });

  app.post('/api/settings/intake', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const kind = String(req.body?.kind ?? ''); const value = str(req.body?.value, 200).toLowerCase();
    if (!INTAKE_KINDS.includes(kind) || !value) return reply.code(400).send({ error: 'kind and value required' });
    const mailboxId = req.body?.mailboxId || null;
    if (mailboxId && !s.store.mailbox(mailboxId)) return reply.code(400).send({ error: 'unknown mailbox' });
    const id = newId();
    db.prepare('INSERT INTO intake_rules (id, business_id, mailbox_id, kind, value) VALUES (?, ?, ?, ?, ?)').run(id, s.business.id, mailboxId, kind, value);
    audit(s, 'intake_add', id, { kind, value });
    return { id };
  });

  app.delete('/api/settings/intake/:id', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const r = db.prepare('DELETE FROM intake_rules WHERE id = ? AND business_id = ?').run(req.params.id, s.business.id);
    if (!r.changes) return reply.code(404).send({ error: 'not found' });
    audit(s, 'intake_remove', req.params.id);
    return { ok: true };
  });

  // Team (D17): invite by Google address; they sign in with that account.
  app.post('/api/team', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const email = str(req.body?.email, 200).toLowerCase();
    const role = ['owner', 'partner'].includes(req.body?.role) ? req.body.role : 'staff';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'valid email required' });
    const id = newId();
    db.prepare(`INSERT INTO users (id, business_id, email, name, role) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (business_id, email) DO UPDATE SET role = excluded.role`).run(id, s.business.id, email, str(req.body?.name, 100) || null, role);
    const u = db.prepare('SELECT id FROM users WHERE business_id = ? AND email = ?').get(s.business.id, email);
    // A partner starts with only the mailboxes granted here (none by default); staff/owner need no grants.
    if (role === 'partner') setPartnerAccess(db, { businessId: s.business.id, userId: u.id, grants: req.body?.access, grantedBy: s.user.id });
    else db.prepare('DELETE FROM partner_mailboxes WHERE user_id = ?').run(u.id);
    audit(s, 'team_invite', email, { role, access: role === 'partner' ? partnerAccessList(db, s.business.id, u.id) : undefined });
    return { ok: true };
  });

  // D8 partner: which mailboxes they see, and from which they may send ([{mailboxId, canSend}]).
  app.put('/api/team/:id/access', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const target = db.prepare('SELECT * FROM users WHERE id = ? AND business_id = ?').get(req.params.id, s.business.id);
    if (!target) return reply.code(404).send({ error: 'not found' });
    if (target.role !== 'partner') return reply.code(400).send({ error: 'only partners have limited access' });
    setPartnerAccess(db, { businessId: s.business.id, userId: target.id, grants: Array.isArray(req.body?.access) ? req.body.access : [], grantedBy: s.user.id });
    const access = partnerAccessList(db, s.business.id, target.id);
    audit(s, 'partner_access', target.email, { access });
    return { ok: true, access };
  });

  app.delete('/api/team/:id', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    if (req.params.id === s.user.id) return reply.code(400).send({ error: 'you cannot remove yourself' });
    const target = db.prepare('SELECT * FROM users WHERE id = ? AND business_id = ?').get(req.params.id, s.business.id);
    if (!target) return reply.code(404).send({ error: 'not found' });
    const owners = db.prepare("SELECT COUNT(*) AS n FROM users WHERE business_id = ? AND role = 'owner'").get(s.business.id).n;
    if (target.role === 'owner' && owners <= 1) return reply.code(400).send({ error: 'a company needs at least one owner' });
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      db.prepare('UPDATE threads SET assignee_user_id = NULL WHERE assignee_user_id = ?').run(target.id);
      db.prepare('DELETE FROM partner_mailboxes WHERE user_id = ?').run(target.id);
      // Sends and drafts keep their author id for the audit trail; the login is what goes.
      db.prepare("UPDATE users SET role = 'staff', email = email || '#removed-' || id WHERE id = ?").run(target.id);
    })();
    audit(s, 'team_remove', target.email);
    return { ok: true };
  });
}

export { BUILT_IN_LABELS };
