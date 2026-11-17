// apps/server/src/routes/connect.js — connect a Gmail mailbox to a business.
// Phase 2 (before console sign-in exists): starting a connection needs the
// ADMIN_TOKEN, and only Tobira staff hold it. New mailboxes start in shadow mode.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { googleClient } from '../config.js';
import { authUrl, exchangeCode, emailFromIdToken, CALENDAR_SCOPES, SIGNER_SCOPES } from '../google.js';
import { encrypt } from '../crypto.js';
import { newId } from '../store.js';
import { currentSession } from '../auth.js';

const STATE_TTL_MS = 10 * 60 * 1000;

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

const page = (title, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font:16px/1.7 system-ui,sans-serif;color:#111;background:#fff;max-width:36rem;margin:12vh auto;padding:0 16px}h1{font-size:1.4rem}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function registerConnectRoutes(app, { db, config, exchange = exchangeCode }) {
  const redirectUri = `${config.publicUrl}/auth/google/callback`;

  // purpose='calendar': writes only mailboxes.calendar_token_enc of the mailbox the consent was started
  // for. Never touches token_enc and never inserts a mailbox, so a calendar failure cannot break mail.
  async function finishCalendar(row, code, reply) {
    const fail = (msg, status = 400) => reply.code(status).send(page('カレンダーを接続できませんでした', esc(msg)));
    const mbx = row.mailbox_id && db.prepare('SELECT id, address FROM mailboxes WHERE id = ? AND business_id = ?').get(row.mailbox_id, row.business_id);
    if (!mbx) return fail('メールボックスが見つかりません。');
    let tokens;
    try {
      const gc = googleClient(config, row.oauth_client);
      tokens = await exchange({ clientId: gc.clientId, clientSecret: gc.clientSecret, redirectUri, code });
    } catch (err) { return fail(err.message, 502); }
    if (!tokens.id_token) return fail('Google アカウントを確認できませんでした。');
    const email = emailFromIdToken(tokens.id_token);
    if (!email || email !== String(mbx.address).toLowerCase()) return fail(`${mbx.address} のアカウントで許可してください。`);
    if (!tokens.refresh_token) return fail('長期の接続許可が返されませんでした。もう一度お試しください。');
    db.prepare("UPDATE mailboxes SET calendar_token_enc = ?, calendar_status = 'ok', calendar_error = NULL WHERE id = ? AND business_id = ?")
      .run(encrypt(tokens.refresh_token, config.masterKey), mbx.id, row.business_id);
    db.prepare("INSERT INTO audit_log (business_id, action, target) VALUES (?, 'calendar_connected', ?)").run(row.business_id, mbx.address);
    return reply.redirect(row.return_to || '/#settings');
  }

  app.get('/connect/google', async (req, reply) => {
    const { business, key, login_hint: loginHint, signer } = req.query ?? {};
    if (!config.adminToken || !sameSecret(key, config.adminToken)) return reply.code(403).send({ error: 'forbidden' });
    if (!config.clientId || !config.clientSecret || !config.masterKey) return reply.code(503).send({ error: 'google connection not configured' });
    const biz = db.prepare('SELECT id, oauth_client FROM businesses WHERE id = ?').get(business);
    if (!biz) return reply.code(404).send({ error: 'unknown business' });
    const gc = googleClient(config, biz.oauth_client);
    const state = randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO oauth_states (state, business_id, login_hint, oauth_client, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, biz.id, loginHint ?? null, gc.which, new Date(Date.now() + STATE_TTL_MS).toISOString());
    // signer=1: also ask for cloud-platform, for the mailbox named in GOOGLE_SA_SIGNER_MAILBOX (keyless SA signing).
    return reply.redirect(authUrl({ clientId: gc.clientId, redirectUri, state, loginHint, ...(signer === '1' ? { scopes: SIGNER_SCOPES } : {}) }));
  });

  // Owners connect their own mailboxes from the console (setup wizard / settings).
  app.get('/connect/google/me', async (req, reply) => {
    const s = currentSession(db, req, config.masterKey);
    if (!s || s.user.role !== 'owner') return reply.redirect('/');
    if (!config.clientId || !config.clientSecret || !config.masterKey) return reply.code(503).send({ error: 'google connection not configured' });
    const state = randomBytes(24).toString('base64url');
    const back = String(req.query?.back ?? '') === 'setup' ? '/#setup' : '/#settings';
    const gc = googleClient(config, s.business.oauth_client);
    db.prepare("INSERT INTO oauth_states (state, business_id, login_hint, return_to, oauth_client, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(state, s.business.id, req.query?.login_hint ?? null, back, gc.which, new Date(Date.now() + STATE_TTL_MS).toISOString());
    return reply.redirect(authUrl({ clientId: gc.clientId, redirectUri, state, loginHint: req.query?.login_hint }));
  });

  // Calendar consent for one mailbox of a per_mailbox business (plan §3). Dark: 404 while calendar_mode
  // is 'off' or the business uses delegation. Owner only; the consent goes through the mailbox's own client.
  app.get('/connect/google/calendar', async (req, reply) => {
    const s = currentSession(db, req, config.masterKey);
    if (!s) return reply.code(403).send({ error: 'forbidden' });
    const biz = db.prepare('SELECT calendar_mode, calendar_access FROM businesses WHERE id = ?').get(s.business.id);
    if (!biz || biz.calendar_mode === 'off' || biz.calendar_access !== 'per_mailbox') return reply.code(404).send({ error: 'not found' });
    if (s.user.role !== 'owner') return reply.code(403).send({ error: 'forbidden' });
    const mbx = db.prepare('SELECT id, address, oauth_client FROM mailboxes WHERE id = ? AND business_id = ?').get(String(req.query?.mailbox ?? ''), s.business.id);
    if (!mbx) return reply.code(404).send({ error: 'not found' });
    if (!config.clientId || !config.clientSecret || !config.masterKey) return reply.code(503).send({ error: 'google connection not configured' });
    const gc = googleClient(config, mbx.oauth_client);
    const state = randomBytes(24).toString('base64url');
    db.prepare("INSERT INTO oauth_states (state, business_id, login_hint, return_to, oauth_client, purpose, mailbox_id, expires_at) VALUES (?, ?, ?, '/#settings', ?, 'calendar', ?, ?)")
      .run(state, s.business.id, mbx.address, gc.which, mbx.id, new Date(Date.now() + STATE_TTL_MS).toISOString());
    return reply.redirect(authUrl({ clientId: gc.clientId, redirectUri, state, loginHint: mbx.address, scopes: ['openid', 'email', ...CALENDAR_SCOPES] }));
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const { code, state, error } = req.query ?? {};
    reply.type('text/html; charset=utf-8');
    if (error) return reply.code(400).send(page('接続できませんでした', `Google からの応答: ${esc(error)}`));
    const row = state && db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      return reply.code(400).send(page('接続できませんでした', 'このリンクは期限切れか、すでに使用されています。もう一度やり直してください。'));
    }
    db.prepare('UPDATE oauth_states SET used_at = ? WHERE state = ?').run(new Date().toISOString(), state);
    // Same Google callback serves console sign-in (no extra redirect URI to register).
    if (row.purpose === 'login') return app.finishLogin(row, code, reply);
    if (row.purpose === 'calendar') return finishCalendar(row, code, reply);

    let tokens;
    try {
      const gc = googleClient(config, row.oauth_client);
      tokens = await exchange({ clientId: gc.clientId, clientSecret: gc.clientSecret, redirectUri, code });
    } catch (err) {
      return reply.code(502).send(page('接続できませんでした', esc(err.message)));
    }
    const email = emailFromIdToken(tokens.id_token);
    if (!email) return reply.code(400).send(page('接続できませんでした', 'メールアドレスを確認できませんでした。'));
    if (!tokens.refresh_token) {
      return reply.code(400).send(page('接続できませんでした', '長期の接続許可が返されませんでした。Google アカウントの「サードパーティ製アプリ」から一度アクセスを削除して、もう一度お試しください。'));
    }
    const enc = encrypt(tokens.refresh_token, config.masterKey);
    const now = new Date().toISOString();
    const which = googleClient(config, row.oauth_client).which;
    db.prepare(`INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, connected_at, oauth_client)
        VALUES (?, ?, ?, ?, 'connected', 'shadow', ?, ?)
        ON CONFLICT (business_id, address) DO UPDATE SET token_enc = excluded.token_enc, status = 'connected',
          last_error = NULL, connected_at = excluded.connected_at, oauth_client = excluded.oauth_client`)
      .run(newId(), row.business_id, email, enc, now, which);
    db.prepare("INSERT INTO audit_log (business_id, action, target) VALUES (?, 'mailbox_connected', ?)").run(row.business_id, email);
    // A new mailbox gets a starter voice so drafts can begin; the owner edits it in the wizard / settings.
    const mbx = db.prepare('SELECT id, voice_profile_id FROM mailboxes WHERE business_id = ? AND address = ?').get(row.business_id, email);
    if (mbx && !mbx.voice_profile_id) {
      const biz = db.prepare('SELECT name FROM businesses WHERE id = ?').get(row.business_id);
      const vid = newId();
      db.prepare('INSERT INTO voice_profiles (id, business_id, full_name, style, signature, mailbox_address) VALUES (?, ?, ?, ?, ?, ?)')
        .run(vid, row.business_id, email.split('@')[0], '丁寧で温かい、簡潔なビジネス敬語。感嘆符は使わない。', `${biz?.name ?? ''}
${email}`, email);
      db.prepare('UPDATE mailboxes SET voice_profile_id = ? WHERE id = ?').run(vid, mbx.id);
    }
    if (row.return_to) return reply.redirect(row.return_to);
    return reply.send(page('接続しました', `${esc(email)} を TobirAInbox に接続しました（読み取りと仕分けのみ・送信はしません）。このページは閉じて大丈夫です。`));
  });
}
