// apps/server/src/routes/learn.js — website facts (D8), learning (D4/D21/D22), owner questions (D23).
import { Store, newId } from '../store.js';
import { currentSession } from '../auth.js';
import { accessScope, canSee } from '../partner.js';
import { gmailFor } from '../mailboxes.js';
import { readWebsite, assertPublicUrl } from '../website.js';
import { importHistory, proposeRules, RULES_MODEL } from '../learning.js';
import { askOwner, openQuestions, answerQuestion } from '../questions.js';

export function registerLearnRoutes(app, { db, config, ai, gmailFactory, websiteFetcher, pushSend }) {
  const member = (req, reply) => {
    const s = currentSession(db, req, config.masterKey);
    if (!s) { reply.code(401).send({ error: 'sign in required' }); return null; }
    // D8 partner: no playbook, facts or questions; asking about a thread only inside granted mailboxes.
    if (s.user.role === 'partner') {
      const tid = req.url.startsWith('/api/threads/') ? req.params?.id : null;
      const mb = tid && db.prepare('SELECT mailbox_id FROM threads WHERE id = ? AND business_id = ?').get(tid, s.business.id)?.mailbox_id;
      if (!mb || !canSee(accessScope(db, s.user), mb)) { reply.code(403).send({ error: 'not for partners' }); return null; }
    }
    return { ...s, store: new Store(db, s.business.id) };
  };
  const owner = (req, reply) => {
    const s = member(req, reply); if (!s) return null;
    if (s.user.role !== 'owner') { reply.code(403).send({ error: 'owner only' }); return null; }
    return s;
  };

  // Everything the プレイブック tab shows besides rules/facts (those come from /api/settings).
  app.get('/api/learn', async (req, reply) => {
    const s = member(req, reply); if (!s) return;
    const b = s.store.business();
    return {
      website: {
        url: b.website_url ?? null,
        last: db.prepare('SELECT id, url, status, pages, found, error, started_at AS startedAt, finished_at AS finishedAt FROM website_reads WHERE business_id = ? ORDER BY started_at DESC LIMIT 1').get(b.id) ?? null,
      },
      proposals: db.prepare("SELECT id, key, value, source_url AS sourceUrl FROM fact_proposals WHERE business_id = ? AND status = 'pending' ORDER BY created_at").all(b.id),
      examples: {
        total: db.prepare('SELECT COUNT(*) AS n FROM examples WHERE business_id = ?').get(b.id).n,
        fromHistory: db.prepare("SELECT COUNT(*) AS n FROM examples WHERE business_id = ? AND source = 'history'").get(b.id).n,
      },
      rulesProposedAt: b.rules_proposed_at ?? null,
      questions: openQuestions(db, b.id),
    };
  });

  // D8: read the website now (runs in the background; the tab polls /api/learn).
  app.post('/api/website/read', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const url = String(req.body?.url ?? '').trim();
    try { if (!websiteFetcher) await assertPublicUrl(url); } catch (err) { return reply.code(400).send({ error: 'bad_url', message: err.message }); }
    const running = db.prepare("SELECT id FROM website_reads WHERE business_id = ? AND status = 'running' AND started_at > ?").get(s.business.id, new Date(Date.now() - 5 * 60_000).toISOString());
    if (running) return reply.code(409).send({ error: 'already_running', id: running.id });
    db.prepare('UPDATE businesses SET website_url = ? WHERE id = ?').run(url, s.business.id);
    const id = newId();
    db.prepare('INSERT INTO website_reads (id, business_id, url) VALUES (?, ?, ?)').run(id, s.business.id, url);
    s.store.audit(s.user.id, 'website_read', url);
    const job = readWebsite({ db, ai, businessId: s.business.id, url, readId: id, config, ...(websiteFetcher ? { fetcher: websiteFetcher } : {}) }).catch(() => {});
    if (req.query?.wait) await job; // tests
    return { id };
  });

  // Accept (optionally edited) or reject a fact the website read found.
  app.post('/api/facts/proposals/:id', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const p = db.prepare("SELECT * FROM fact_proposals WHERE id = ? AND business_id = ? AND status = 'pending'").get(req.params.id, s.business.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    if (req.body?.action === 'reject') {
      db.prepare("UPDATE fact_proposals SET status = 'rejected' WHERE id = ?").run(p.id);
      return { ok: true };
    }
    const key = String(req.body?.key ?? p.key).trim(); const value = String(req.body?.value ?? p.value).trim();
    if (!key || !value) return reply.code(400).send({ error: 'empty' });
    db.transaction(() => {
      db.prepare(`INSERT INTO facts (id, business_id, key, value, source) VALUES (?, ?, ?, ?, 'website')
        ON CONFLICT (business_id, key) DO UPDATE SET value = excluded.value, source = 'website', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .run(newId(), s.business.id, key, value);
      db.prepare("UPDATE fact_proposals SET status = 'accepted' WHERE id = ?").run(p.id);
    })();
    s.store.audit(s.user.id, 'fact_accepted', key);
    return { ok: true };
  });

  // D4: learn from past sent mail in every connected mailbox (or one).
  app.post('/api/learn/history', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const boxes = s.store.mailboxes().filter((m) => m.status === 'connected' && (!req.body?.mailboxId || m.id === req.body.mailboxId));
    if (!boxes.length) return reply.code(400).send({ error: 'no_mailbox' });
    const out = { seen: 0, saved: 0, failed: [] };
    for (const m of boxes) {
      try { const r = await importHistory(db, { mailbox: m, gmail: gmailFor(m, config, gmailFactory) }); out.seen += r.seen; out.saved += r.saved; } catch (err) { out.failed.push({ mailbox: m.address, error: err.message }); }
    }
    s.store.audit(s.user.id, 'history_imported', String(out.saved));
    return out;
  });

  // D21: propose new playbook rules from what was learned.
  app.post('/api/learn/propose', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    try { return await proposeRules(db, { ai, businessId: s.business.id, config }); } catch (err) { return reply.code(502).send({ error: 'propose_failed', message: err.message }); }
  });

  // Talk a rule through with the AI: the owner says how to change it, gets a rewritten rule back (not saved yet).
  app.post('/api/settings/playbook/:id/refine', async (req, reply) => {
    const s = owner(req, reply); if (!s) return;
    const r = db.prepare('SELECT text FROM playbook_rules WHERE id = ? AND business_id = ?').get(req.params.id, s.business.id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    const instruction = String(req.body?.instruction ?? '').trim().slice(0, 400);
    const current = String(req.body?.text ?? r.text).slice(0, 1000);
    if (!instruction) return reply.code(400).send({ error: 'instruction required' });
    if (!ai) return reply.code(503).send({ error: 'AI not configured' });
    try {
      const res = await ai.complete({ operation: 'rules', model: RULES_MODEL, maxTokens: 600, meter: { businessId: s.business.id },
        prompt: [
          "You edit one reply rule for a small business's email assistant. Apply the owner's request to the rule.",
          'Keep it ONE plain Japanese sentence (two at most) in the same imperative style. Change only what the request asks.',
          'Reply with the rewritten rule only. No quotes, no explanation.',
          '', `RULE: ${current}`, `REQUEST: ${instruction}`,
        ].join('\n') });
      const text = String(res?.text ?? '').trim().replace(/^["「]|["」]$/g, '').split('\n').filter(Boolean).slice(0, 2).join('');
      if (!text) return reply.code(502).send({ error: 'empty' });
      return { text: text.slice(0, 1000) };
    } catch (err) { return reply.code(502).send({ error: 'refine_failed', message: err.message }); }
  });

  // D23: ask the owner about a 【要確認】 in a draft; answer it.
  app.post('/api/threads/:id/ask', async (req, reply) => {
    const s = member(req, reply); if (!s) return;
    const r = await askOwner(db, { businessId: s.business.id, threadId: req.params.id, blank: String(req.body?.blank ?? ''), userId: s.user.id, pushSend });
    if (r.error) return reply.code(r.code).send({ error: r.error });
    return r;
  });
  app.get('/api/questions', async (req, reply) => {
    const s = member(req, reply); if (!s) return;
    return { questions: openQuestions(db, s.business.id) };
  });
  app.post('/api/questions/:id/answer', async (req, reply) => {
    const s = member(req, reply); if (!s) return;
    const r = answerQuestion(db, { businessId: s.business.id, id: req.params.id, answer: req.body?.answer, saveFact: req.body?.saveFact !== false, factKey: req.body?.factKey, userId: s.user.id });
    if (r.error) return reply.code(r.code).send({ error: r.error });
    return r;
  });
}
