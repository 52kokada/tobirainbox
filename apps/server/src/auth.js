// apps/server/src/auth.js — console sign-in with Google (OpenID: email only) and
// cookie sessions. The signed-in user's business is the ONLY way an API request
// chooses whose data it sees (never a request parameter).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { googleClient, loginClient } from './config.js';
import { authUrl, exchangeCode, emailFromIdToken } from './google.js';

const COOKIE = 'tbi_session';
const SESSION_DAYS = 30;
const LOGIN_SCOPES = ['openid', 'email', 'profile'];

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function readCookie(req, name = COOKIE) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(id, secret, { maxAgeDays = SESSION_DAYS } = {}) {
  const val = `${id}.${sign(id, secret)}`;
  return `${COOKIE}=${encodeURIComponent(val)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeDays * 86400}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** Resolve the session from the cookie; returns {user, business, sessionId} or null. */
export function currentSession(db, req, secret) {
  const raw = readCookie(req);
  if (!raw || !secret) return null;
  const [id, mac] = raw.split('.');
  if (!id || !mac) return null;
  const expect = Buffer.from(sign(id, secret)); const got = Buffer.from(mac);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND business_id = ?').get(s.user_id, s.business_id);
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(s.business_id);
  if (!user || !business) return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return { user, business, sessionId: id };
}

export function registerAuthRoutes(app, { db, config, exchange = exchangeCode }) {
  const redirectUri = `${config.publicUrl}/auth/google/callback`;
  const secret = config.masterKey;

  app.get('/auth/login', async (req, reply) => {
    if (!config.clientId) return reply.code(503).send('sign-in not configured');
    const state = randomBytes(24).toString('base64url');
    const which = loginClient(config, { outside: req.query?.outside === '1' });
    db.prepare("INSERT INTO oauth_states (state, business_id, purpose, oauth_client, expires_at) VALUES (?, (SELECT id FROM businesses LIMIT 1), 'login', ?, ?)")
      .run(state, which, new Date(Date.now() + 10 * 60_000).toISOString());
    const url = new URL(authUrl({ clientId: googleClient(config, which).clientId, redirectUri, state }));
    url.searchParams.set('scope', LOGIN_SCOPES.join(' '));
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    return reply.redirect(url.toString());
  });

  // Invite-only self-serve sign-up (D20, D25): /signup?code=… → Google → new company + owner → setup wizard.
  app.get('/signup', async (req, reply) => {
    const code = String(req.query?.code ?? '').trim();
    const inv = code && db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
    if (!inv || inv.used_at) {
      return reply.code(400).type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px/1.7 system-ui;max-width:32rem;margin:16vh auto;padding:0 16px">
        <h1 style="font-size:1.4rem">招待コードが使えません</h1><p>このコードは無効か、すでに使われています。TobirAInbox は現在招待制です。</p><p><a href="/">ログイン画面へ</a></p>`);
    }
    if (!config.clientId) return reply.code(503).send('sign-in not configured');
    const state = randomBytes(24).toString('base64url');
    const which = loginClient(config, { outside: true });
    db.prepare("INSERT INTO oauth_states (state, business_id, purpose, return_to, oauth_client, expires_at) VALUES (?, (SELECT id FROM businesses LIMIT 1), 'login', ?, ?, ?)")
      .run(state, `signup:${code}`, which, new Date(Date.now() + 10 * 60_000).toISOString());
    const url = new URL(authUrl({ clientId: googleClient(config, which).clientId, redirectUri, state }));
    url.searchParams.set('scope', LOGIN_SCOPES.join(' '));
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    return reply.redirect(url.toString());
  });

  // Called from the shared /auth/google/callback when the state's purpose is 'login'.
  app.decorate('finishLogin', async (row, code, reply) => {
    let tokens;
    const gc = googleClient(config, row.oauth_client);
    try { tokens = await exchange({ clientId: gc.clientId, clientSecret: gc.clientSecret, redirectUri, code }); } catch (err) {
      return reply.code(502).type('text/html; charset=utf-8').send(`<p>ログインできませんでした: ${String(err.message).replace(/</g, '&lt;')}</p>`);
    }
    const email = emailFromIdToken(tokens.id_token);
    let users = email ? db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').all(email) : [];
    let fresh = false;
    const invite = String(row.return_to ?? '').startsWith('signup:') ? row.return_to.slice(7) : null;
    if (!users.length && email && invite) {
      const inv = db.prepare('SELECT * FROM invites WHERE code = ? AND used_at IS NULL').get(invite);
      if (inv) {
        const bizId = randomBytes(12).toString('hex'); const userId = randomBytes(12).toString('hex');
        db.transaction(() => {
          // Outside businesses connect Gmail through the external client once it exists (internal = example.com only).
          db.prepare("INSERT INTO businesses (id, name, status, oauth_client) VALUES (?, ?, 'active', ?)").run(bizId, inv.note || email.split('@')[1], googleClient(config, 'external').which);
          db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, ?, 'owner')").run(userId, bizId, email);
          db.prepare('UPDATE invites SET used_at = ?, used_by_email = ?, business_id = ? WHERE code = ?').run(new Date().toISOString(), email, bizId, invite);
          db.prepare("INSERT INTO audit_log (business_id, user_id, action, target) VALUES (?, ?, 'signup', ?)").run(bizId, userId, invite);
        })();
        users = db.prepare('SELECT * FROM users WHERE id = ?').all(userId); fresh = true;
      }
    }
    if (!users.length) {
      return reply.code(403).type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:16px">
        <h1>このアカウントは招待されていません</h1><p>${(email ?? '').replace(/</g, '&lt;')} は TobirAInbox に登録されていません。管理者に招待を依頼してください。</p><p><a href="/auth/login">別のアカウントで試す</a></p>`);
    }
    // D8: the same person may belong to several businesses; open the one they used last (switch in the console).
    const user = [...users].sort((a, b) => String(b.last_login_at ?? '').localeCompare(String(a.last_login_at ?? '')))[0];
    const id = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (id, user_id, business_id, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, user.id, user.business_id, new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString());
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), user.id);
    db.prepare("INSERT INTO audit_log (business_id, user_id, action) VALUES (?, ?, 'login')").run(user.business_id, user.id);
    reply.header('set-cookie', sessionCookie(id, secret));
    return reply.redirect(fresh ? '/#setup' : '/');
  });

  // D8: move this person's session to another business they belong to (same Google email, their role there).
  app.post('/api/me/switch', async (req, reply) => {
    const s = currentSession(db, req, secret);
    if (!s) return reply.code(401).send({ error: 'login required' });
    const target = db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND business_id = ?').get(s.user.email, String(req.body?.businessId ?? ''));
    if (!target) return reply.code(404).send({ error: 'not a member of that business' });
    const id = randomBytes(32).toString('base64url');
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(s.sessionId);
      db.prepare('INSERT INTO sessions (id, user_id, business_id, expires_at) VALUES (?, ?, ?, ?)')
        .run(id, target.id, target.business_id, new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString());
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), target.id);
      db.prepare("INSERT INTO audit_log (business_id, user_id, action) VALUES (?, ?, 'switch_business')").run(target.business_id, target.id);
    })();
    reply.header('set-cookie', sessionCookie(id, secret));
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    const s = currentSession(db, req, secret);
    if (s) db.prepare('DELETE FROM sessions WHERE id = ?').run(s.sessionId);
    reply.header('set-cookie', clearCookie());
    return { ok: true };
  });
}
