// apps/server/src/routes/admin.js — Tobira-staff review page for the shadow run
// (before the console exists). Behind ADMIN_TOKEN. Shows each AI draft next to
// the email's cached sender/subject/snippet, and records a 0/1/2 rating for the
// Phase 3 exit check. Never sends anything.
import { timingSafeEqual } from 'node:crypto';
import { googleClient } from '../config.js';
import { redact, parseFrom } from '@tobira-inbox/engine';
import { Store, validTimezone, parseFreeSlotHours } from '../store.js';
import { decrypt } from '../crypto.js';
import { Gmail } from '../gmail.js';
import { LABEL_PREFIX } from '../ingest.js';
import { syncPlaybook } from '../playbook-sync.js';
import { requestResync } from '../calendar-sync.js';
import { closeForClient, DeadlineError } from '../deadlines.js';

function ok(key, token) {
  const a = Buffer.from(String(key ?? '')); const b = Buffer.from(String(token ?? ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RATING = { 2: 'そのまま送れる', 1: '少し直せば送れる', 0: '書き直し' };

export function registerAdminRoutes(app, { db, config }) {
  // Load an outside playbook (the Tobira outreach playbook) as one business's rules.
  // PUT /admin/playbook-sync?key=  {business: name, prefix: 'tobira-playbook:', rules: [{key, text, phase?, label?}]}
  app.put('/admin/playbook-sync', async (req, reply) => {
    const { key } = req.query ?? {};
    if (!config.adminToken || !ok(key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const b = req.body ?? {};
    const biz = db.prepare('SELECT id FROM businesses WHERE name = ?').get(String(b.business ?? ''));
    if (!biz) return reply.code(404).send({ error: 'business not found' });
    try { return { ok: true, ...syncPlaybook(db, { businessId: biz.id, prefix: b.prefix, rules: b.rules }) }; }
    catch (err) { return reply.code(400).send({ error: err.message }); }
  });

  // One-time sign-up links for invited companies (D20/D25).
  app.post('/admin/invites', async (req, reply) => {
    const { key } = req.query ?? {};
    if (!config.adminToken || !ok(key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const code = (await import('node:crypto')).randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO invites (code, note) VALUES (?, ?)').run(code, req.body?.note ?? null);
    return { code, url: `${config.publicUrl}/signup?code=${code}` };
  });

  // Calendar settings of one business (plan step 3). Admin-only until Tobira is switched on: mode
  // (off|shadow|on, D45), access, the 調整中 calendar and its owner mailbox (D43), shadow calendar,
  // silence days (D46). Timezone and free-slot hours are accepted here too; owners also set those.
  app.get('/admin/businesses/:id/calendar', async (req, reply) => {
    if (!config.adminToken || !ok(req.query?.key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const settings = new Store(db, req.params.id).calendarSettings();
    if (!settings) return reply.code(404).send({ error: 'not found' });
    return settings;
  });

  // Manual calendar sync (plan step 6): the worker's next pass (within POLL_SECONDS) fully resyncs this
  // business. 409 while calendar_mode is 'off', since nothing is synced then.
  app.post('/admin/businesses/:id/calendar/sync', async (req, reply) => {
    if (!config.adminToken || !ok(req.query?.key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const settings = new Store(db, req.params.id).calendarSettings();
    if (!settings) return reply.code(404).send({ error: 'not found' });
    if (settings.mode === 'off') return reply.code(409).send({ error: 'calendar_mode is off' });
    return { ok: true, calendars: requestResync(db, req.params.id) };
  });

  // D57: the publish hook. A publish script (tobira's publish:preview) calls this after a preview goes live:
  //   POST /admin/businesses/:id/deadlines/close?key=ADMIN_TOKEN  {client: '<slug|address|domain|label>' | threadId, reason: 'published'}
  // Closes the matching open deadlines with done_reason = reason. 409 while calendar_mode is 'off'.
  app.post('/admin/businesses/:id/deadlines/close', async (req, reply) => {
    if (!config.adminToken || !ok(req.query?.key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const settings = new Store(db, req.params.id).calendarSettings();
    if (!settings) return reply.code(404).send({ error: 'not found' });
    if (settings.mode === 'off') return reply.code(409).send({ error: 'calendar_mode is off' });
    const b = req.body ?? {};
    if (!b.client && !b.threadId) return reply.code(400).send({ error: 'client or threadId required' });
    try {
      const closed = closeForClient(db, { businessId: req.params.id, client: b.client, threadId: b.threadId, reason: b.reason ?? 'published' });
      return { ok: true, closed };
    } catch (err) {
      if (err instanceof DeadlineError) return reply.code(400).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.put('/admin/businesses/:id/calendar', async (req, reply) => {
    if (!config.adminToken || !ok(req.query?.key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const store = new Store(db, req.params.id);
    if (!store.business()) return reply.code(404).send({ error: 'not found' });
    const b = req.body ?? {};
    const sets = []; const args = [];
    const set = (col, v) => { sets.push(`${col} = ?`); args.push(v); };
    const optStr = (v) => (v === null || v === '' ? null : String(v).trim().slice(0, 300));
    if (b.calendarMode !== undefined) {
      if (!['off', 'shadow', 'on'].includes(b.calendarMode)) return reply.code(400).send({ error: 'calendarMode must be off, shadow or on' });
      set('calendar_mode', b.calendarMode);
    }
    if (b.calendarAccess !== undefined) {
      if (!['delegated', 'per_mailbox'].includes(b.calendarAccess)) return reply.code(400).send({ error: 'calendarAccess must be delegated or per_mailbox' });
      set('calendar_access', b.calendarAccess);
    }
    if (b.holdCalendarOwnerMailboxId !== undefined) {
      const v = b.holdCalendarOwnerMailboxId || null;
      if (v && !store.mailbox(v)) return reply.code(400).send({ error: 'hold calendar owner must be a mailbox of this business' });
      set('hold_calendar_owner_mailbox_id', v);
    }
    if (b.holdCalendarId !== undefined) set('hold_calendar_id', optStr(b.holdCalendarId));
    if (b.shadowCalendarId !== undefined) set('shadow_calendar_id', optStr(b.shadowCalendarId));
    if (b.holdSilenceDays !== undefined) {
      const v = Number(b.holdSilenceDays);
      if (!(Number.isInteger(v) && v >= 1 && v <= 90)) return reply.code(400).send({ error: 'holdSilenceDays must be 1-90' });
      set('hold_silence_days', v);
    }
    if (b.timezone !== undefined) {
      if (!validTimezone(b.timezone)) return reply.code(400).send({ error: 'timezone must be an IANA zone' });
      set('timezone', b.timezone);
    }
    if (b.freeSlotHours !== undefined) {
      const v = parseFreeSlotHours(b.freeSlotHours);
      if (!v) return reply.code(400).send({ error: 'freeSlotHours needs days 0-6 and from < to as HH:MM' });
      set('free_slot_hours', JSON.stringify(v));
    }
    if (sets.length) {
      db.prepare(`UPDATE businesses SET ${sets.join(', ')} WHERE id = ?`).run(...args, store.businessId);
      store.audit(null, 'admin_calendar_settings', store.businessId, b);
    }
    return store.calendarSettings();
  });

  app.get('/admin/drafts', async (req, reply) => {
    const { key } = req.query ?? {};
    if (!config.adminToken || !ok(key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const rows = db.prepare(`SELECT d.id, d.body_text, d.blanks_json, d.model, d.rating, d.created_at,
        t.label_key, t.cache_from, t.cache_subject, t.cache_snippet, m.address
      FROM drafts d JOIN threads t ON t.id = d.thread_id JOIN mailboxes m ON m.id = t.mailbox_id
      WHERE d.created_by = 'ai' ORDER BY d.created_at DESC LIMIT 100`).all();
    const rated = rows.filter((r) => r.rating != null);
    const good = rated.filter((r) => r.rating >= 1).length;
    const cost = db.prepare("SELECT ROUND(COALESCE(SUM(cost_usd),0),4) AS usd, COUNT(*) AS n FROM ai_usage WHERE at >= strftime('%Y-%m-%dT00:00:00Z','now')").get();
    const cards = rows.map((r) => {
      const blanks = JSON.parse(r.blanks_json || '[]');
      const buttons = [2, 1, 0].map((v) => `<form method="post" action="/admin/drafts/${r.id}/rate?key=${encodeURIComponent(key)}" style="display:inline">
        <input type="hidden" name="rating" value="${v}"><button ${r.rating === v ? 'class="on"' : ''}>${RATING[v]}</button></form>`).join(' ');
      return `<article><p class="meta">${esc(r.address)} · ${esc(r.label_key)} · ${esc(r.model)} · ${esc(r.created_at)}</p>
        <p><b>${esc(r.cache_from)}</b><br>${esc(r.cache_subject)}</p><blockquote>${esc(r.cache_snippet)}</blockquote>
        ${blanks.length ? `<p class="blank">要確認: ${blanks.map(esc).join(' / ')}</p>` : ''}
        <pre>${esc(r.body_text)}</pre><p>${buttons}</p></article>`;
    }).join('\n');
    reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>下書きレビュー</title><style>
:root{--ink:#111;--bg:#fff;--line:#ddd;--accent:#0a5}
@media (prefers-color-scheme:dark){:root{--ink:#eee;--bg:#121212;--line:#333;--accent:#3c8}}
body{font:15px/1.7 system-ui,sans-serif;color:var(--ink);background:var(--bg);max-width:52rem;margin:0 auto;padding:16px}
article{border-top:1px solid var(--line);padding:16px 0}.meta{font-size:13px}blockquote{margin:0;padding-left:12px;border-left:3px solid var(--line)}
pre{white-space:pre-wrap;font:inherit;background:transparent;border:1px solid var(--line);padding:12px;border-radius:8px}
.blank{font-weight:600}button{font:inherit;padding:6px 12px;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px}
button.on{border-color:var(--accent);font-weight:700}</style></head><body>
<h1>下書きレビュー（試運転・送信なし）</h1>
<p>評価済み ${rated.length} 件中、送れる（そのまま＋少し直せば）${good} 件${rated.length ? `（${Math.round(good / rated.length * 100)}%）` : ''}。目標 80%。本日の AI 費用 $${cost.usd}（${cost.n} 回）。</p>
${cards || '<p>まだ下書きはありません。</p>'}</body></html>`);
  });

  app.post('/admin/drafts/:id/rate', async (req, reply) => {
    const { key } = req.query ?? {};
    if (!config.adminToken || !ok(key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const rating = Number(req.body?.rating);
    if (![0, 1, 2].includes(rating)) return reply.code(400).send({ error: 'rating must be 0, 1 or 2' });
    db.prepare('UPDATE drafts SET rating = ?, rated_at = ? WHERE id = ?').run(rating, new Date().toISOString(), req.params.id);
    return reply.redirect(`/admin/drafts?key=${encodeURIComponent(key)}`);
  });

  // 仕分け: 要確認 first, then recent mail, each with a label picker. A person's
  // choice is saved as a correction (contact details removed) that the sorter
  // reads on its next run.
  app.get('/admin/sort', async (req, reply) => {
    const { key } = req.query ?? {};
    if (!config.adminToken || !ok(key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const rows = db.prepare(`SELECT t.id, t.business_id, t.label_key, t.label_by, t.label_guess, t.label_confidence, t.cache_from, t.cache_subject, t.cache_snippet, t.last_message_at, m.address
      FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id
      ORDER BY (t.label_key = 'unconfirmed') DESC, t.last_message_at DESC LIMIT 80`).all();
    const learned = db.prepare('SELECT COUNT(*) AS n FROM label_corrections').get().n;
    const cards = rows.map((r) => {
      const labels = new Store(db, r.business_id).labels().filter((l) => !l.hidden);
      const opts = labels.map((l) => `<option value="${l.key}" ${l.key === r.label_key ? 'selected' : ''}>${esc(l.ja)}</option>`).join('');
      const why = r.label_by === 'person' ? '人が仕分け' : r.label_key === 'unconfirmed'
        ? `要確認${r.label_guess ? `（AI の推測: ${esc(r.label_guess)} ${Math.round((r.label_confidence ?? 0) * 100)}%）` : ''}`
        : `${esc(r.label_by)} ${r.label_confidence != null ? Math.round(r.label_confidence * 100) + '%' : ''}`;
      return `<article><p class="meta">${esc(r.address)} · ${esc(r.last_message_at)} · ${why}</p>
        <p><b>${esc(r.cache_from)}</b><br>${esc(r.cache_subject)}</p><blockquote>${esc(r.cache_snippet)}</blockquote>
        <form method="post" action="/admin/threads/${r.id}/label?key=${encodeURIComponent(key)}"><select name="label">${opts}</select> <button>この仕分けにする</button></form></article>`;
    }).join('\n');
    reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>仕分けの確認</title><style>
:root{--ink:#111;--bg:#fff;--line:#ddd}@media (prefers-color-scheme:dark){:root{--ink:#eee;--bg:#121212;--line:#333}}
body{font:15px/1.7 system-ui,sans-serif;color:var(--ink);background:var(--bg);max-width:52rem;margin:0 auto;padding:16px}
article{border-top:1px solid var(--line);padding:14px 0}.meta{font-size:13px}blockquote{margin:0;padding-left:12px;border-left:3px solid var(--line)}
select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:6px}</style></head><body>
<h1>仕分けの確認（試運転）</h1><p>確信が持てなかったメールは「要確認」に入ります。正しい仕分けを選ぶと、次から同じようなメールに反映されます。これまでの学習: ${learned} 件。</p>
${cards || '<p>まだメールはありません。</p>'}</body></html>`);
  });

  app.post('/admin/threads/:id/label', async (req, reply) => {
    const { key } = req.query ?? {};
    if (!config.adminToken || !ok(key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
    if (!t) return reply.code(404).send({ error: 'no thread' });
    const store = new Store(db, t.business_id);
    const to = String(req.body?.label ?? '');
    if (!store.labels().some((l) => l.key === to)) return reply.code(400).send({ error: 'unknown label' });
    const from = parseFrom(t.cache_from ?? '');
    db.transaction(() => {
      db.prepare("UPDATE threads SET label_key = ?, label_by = 'person', updated_at = ? WHERE id = ?").run(to, new Date().toISOString(), t.id);
      if (to !== t.label_key) {
        db.prepare(`INSERT INTO label_corrections (business_id, thread_id, from_label, to_label, from_domain, subject_redacted, excerpt_redacted)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(t.business_id, t.id, t.label_key, to, from.split('@')[1] ?? null,
          redact(t.cache_subject ?? '').slice(0, 120), redact(t.cache_snippet ?? '').slice(0, 200));
      }
      store.audit(null, 'relabel', t.id, { from: t.label_key, to });
    })();
    // Best effort: mirror the new label in Gmail.
    try {
      const mbx = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(t.mailbox_id);
      if (mbx?.write_labels && mbx.token_enc && config.clientId) {
        const gc = googleClient(config, mbx.oauth_client);
        const g = new Gmail({ clientId: gc.clientId, clientSecret: gc.clientSecret, refreshToken: decrypt(mbx.token_enc, config.masterKey) });
        const all = (await g.labels()).filter((l) => l.name.startsWith(`${LABEL_PREFIX}/`));
        const ja = store.labels().find((l) => l.key === to)?.ja;
        let target = all.find((l) => l.name === `${LABEL_PREFIX}/${ja}`);
        if (!target) target = await g.createLabel(`${LABEL_PREFIX}/${ja}`);
        await g.modifyThread(t.gmail_thread_id, { add: [target.id], remove: all.filter((l) => l.id !== target.id).map((l) => l.id) });
      }
    } catch { /* label mirror is best effort; the console is the source of truth */ }
    return reply.redirect(`/admin/sort?key=${encodeURIComponent(key)}`);
  });

  // Spend per company (robust per-company spend tracking).
  app.get('/admin/usage', async (req, reply) => {
    const { key, format } = req.query ?? {};
    if (!config.adminToken || !ok(key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    const companies = db.prepare('SELECT id, name FROM businesses ORDER BY name').all().map((b) => {
      const st = new Store(db, b.id);
      return {
        ...b, spend: st.spend(),
        defaultCapUsd: config.aiDailyCapUsd,
        byMailbox: db.prepare(`SELECT COALESCE(m.address, '(none)') AS mailbox, COUNT(*) AS calls, ROUND(SUM(u.cost_usd), 4) AS usd
          FROM ai_usage u LEFT JOIN mailboxes m ON m.id = u.mailbox_id
          WHERE u.business_id = ? AND u.at >= strftime('%Y-%m-01T00:00:00Z','now') GROUP BY 1 ORDER BY usd DESC`).all(b.id),
        daily: db.prepare(`SELECT day, ROUND(SUM(cost_usd), 4) AS usd, SUM(calls) AS calls FROM ai_usage_daily
          WHERE business_id = ? GROUP BY day ORDER BY day DESC LIMIT 31`).all(b.id),
        outcomes: db.prepare("SELECT COALESCE(outcome,'ok') AS outcome, COUNT(*) AS n FROM ai_usage WHERE business_id = ? GROUP BY 1").all(b.id),
        drafts: db.prepare('SELECT status, COUNT(*) AS n FROM draft_attempts WHERE business_id = ? GROUP BY status').all(b.id),
      };
    });
    if (format === 'json') return { at: new Date().toISOString(), companies };
    const money = (v) => `$${Number(v ?? 0).toFixed(4)}`;
    const table = (rows, cols) => `<table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(/usd/.test(c) ? money(r[c]) : r[c])}</td>`).join('')}</tr>`).join('')}</table>`;
    const html = companies.map((c) => {
      const cap = c.spend.capUsd ?? c.defaultCapUsd;
      return `<section><h2>${esc(c.name)}</h2>
      <p>今日 <b>${money(c.spend.today.usd)}</b>（上限 ${cap > 0 ? money(cap) : 'なし'}／日）· 直近7日 <b>${money(c.spend.last7.usd)}</b> · 今月 <b>${money(c.spend.month.usd)}</b></p>
      <h3>今月・処理別</h3>${table(c.spend.month.rows, ['operation', 'model', 'calls', 'tokens_in', 'tokens_out', 'cache_read', 'usd'])}
      <h3>今月・メールボックス別</h3>${table(c.byMailbox, ['mailbox', 'calls', 'usd'])}
      <h3>日別</h3>${table(c.daily, ['day', 'calls', 'usd'])}
      <p>結果: ${c.outcomes.map((o) => `${esc(o.outcome)} ${o.n}`).join(' · ') || '—'} ／ 下書き: ${c.drafts.map((d) => `${esc(d.status)} ${d.n}`).join(' · ') || '—'}</p></section>`;
    }).join('');
    reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 利用料</title><style>:root{--ink:#111;--bg:#fff;--line:#ddd}@media (prefers-color-scheme:dark){:root{--ink:#eee;--bg:#121212;--line:#333}}
body{font:15px/1.6 system-ui,sans-serif;color:var(--ink);background:var(--bg);max-width:60rem;margin:0 auto;padding:16px}
table{border-collapse:collapse;width:100%;margin:6px 0 14px;font-variant-numeric:tabular-nums;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;white-space:nowrap}
section{border-top:2px solid var(--line);margin-top:18px}</style></head><body><h1>AI 利用料（会社別）</h1>
<p>Claude API の全呼び出しを記録しています（拒否・失敗も含む）。金額は料金表 claude-api-2026-10-06 で計算。JSON: <code>?format=json</code></p>${html}</body></html>`);
  });
}
