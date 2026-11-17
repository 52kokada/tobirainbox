// Calendar plan step 4: the calendar client, the service-account token source with both signers
// (local key, keyless IAM signJwt), and the per-mailbox calendar consent. All dark behind calendar_mode.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { CALENDAR_SCOPES, SIGNER_SCOPES, GMAIL_SCOPES } from '../src/google.js';
import { loadConfig } from '../src/config.js';
import { tokenFor } from '../src/token-source.js';
import { Calendar, CalendarError, calendarFor } from '../src/calendar.js';
import {
  SaTokens, SaTokenError, jwtClaims, assertDelegable, localKeySigner, iamSigner, mailboxImpersonator, signerFromConfig, TOKEN_URL,
} from '../src/sa-token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const masterKey = randomBytes(32).toString('base64');
const SA = 'inbox-calendar@example-project.iam.gserviceaccount.com';
const base = { clientId: 'c', clientSecret: 's', masterKey, publicUrl: 'https://inbox.example.com', adminToken: 'ADMIN', aiDailyCapUsd: 0.5,
  googleSaDomains: 'example.com,example.org' };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;
const decodeJwt = (jwt) => jwt.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8')));

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_JSON = { type: 'service_account', client_email: SA, private_key_id: 'kid1', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const KEY_B64 = Buffer.from(JSON.stringify(KEY_JSON)).toString('base64');

/** A fake fetch: routes by URL prefix, records calls. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    for (const [prefix, handler] of routes) {
      if (String(url).startsWith(prefix)) {
        const { status = 200, json = {} } = await handler(String(url), init);
        return { ok: status < 400, status, json: async () => json };
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  f.calls = calls;
  return f;
}

let db; let tobira; let shop; let leo; let info; let shopBox; let ownerShop; let staffShop;
beforeEach(() => {
  db = openDb(':memory:');
  tobira = newId(); shop = newId(); leo = newId(); info = newId(); shopBox = newId();
  db.prepare("INSERT INTO businesses (id, name, status, calendar_access) VALUES (?, 'Tobira', 'active', 'delegated'), (?, 'Shop', 'active', 'per_mailbox')").run(tobira, shop);
  const mbx = db.prepare("INSERT INTO mailboxes (id, business_id, address, token_enc, status, mode, write_labels) VALUES (?, ?, ?, ?, ?, 'live', 0)");
  mbx.run(leo, tobira, 'leo@example.com', encrypt('gmail-refresh-leo', masterKey), 'connected');
  mbx.run(info, tobira, 'info@example.org', encrypt('gmail-refresh-info', masterKey), 'connected');
  mbx.run(newId(), tobira, 'gus@example.com', encrypt('r', masterKey), 'disconnected');
  mbx.run(shopBox, shop, 'info@shop.jp', encrypt('gmail-refresh-shop', masterKey), 'connected');
  ownerShop = newId(); staffShop = newId();
  db.prepare("INSERT INTO users (id, business_id, email, role) VALUES (?, ?, 'owner@shop.jp', 'owner'), (?, ?, 'staff@shop.jp', 'staff')").run(ownerShop, shop, staffShop, shop);
});

// --- sa-token -------------------------------------------------------------------------------------

test('JWT claims: issuer, subject, calendar scopes only, audience, one hour', () => {
  const c = jwtClaims({ serviceAccountEmail: SA, subject: 'leo@example.com', nowS: 1000 });
  assert.deepEqual(c, { iss: SA, sub: 'leo@example.com', scope: CALENDAR_SCOPES.join(' '), aud: TOKEN_URL, iat: 1000, exp: 4600 });
  assert.equal(c.scope, 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly');
});

test('sa-token refuses addresses outside GOOGLE_SA_DOMAINS, non-connected mailboxes and non-delegated businesses', () => {
  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { assert.ok(e instanceof SaTokenError); return e.code; } };
  assert.equal(code(() => assertDelegable(db, base, 'leo@example.com')), 'ok');
  assert.equal(code(() => assertDelegable(db, base, 'info@example.org')), 'ok', 'D52 secondary domain');
  assert.equal(code(() => assertDelegable(db, base, 'someone@gmail.com')), 'domain_not_allowed');
  assert.equal(code(() => assertDelegable(db, base, 'kit@example.com')), 'not_a_delegated_mailbox', 'in the domain but not a mailbox');
  assert.equal(code(() => assertDelegable(db, base, 'gus@example.com')), 'not_a_delegated_mailbox', 'mailbox not connected');
  assert.equal(code(() => assertDelegable(db, { ...base, googleSaDomains: 'example.com,shop.jp' }, 'info@shop.jp')), 'not_a_delegated_mailbox', 'business is per_mailbox');
  assert.equal(code(() => assertDelegable(db, { ...base, googleSaDomains: '' }, 'leo@example.com')), 'domain_not_allowed', 'empty list allows nobody');
  assert.equal(code(() => assertDelegable(db, base, '')), 'domain_not_allowed');
});

test('local-key signer: RS256 JWT verifies with the public key; exchanged once and cached per subject', async () => {
  const signer = localKeySigner(KEY_B64);
  assert.equal(signer.serviceAccountEmail, SA);
  let t = 0;
  const fetchImpl = fakeFetch([[TOKEN_URL, (_u, init) => ({ json: { access_token: `at-${++t}`, expires_in: 3600, _body: String(init.body) } })]]);
  let now = 1_800_000_000_000;
  const tokens = new SaTokens({ db, config: base, signer, fetchImpl, now: () => now });
  assert.equal(await tokens.accessToken('leo@example.com'), 'at-1');
  const body = new URLSearchParams(fetchImpl.calls[0].body);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const jwt = body.get('assertion');
  const [head, claims] = decodeJwt(jwt);
  assert.deepEqual(head, { alg: 'RS256', typ: 'JWT', kid: 'kid1' });
  assert.equal(claims.sub, 'leo@example.com');
  assert.equal(claims.iss, SA);
  const [h, p, sig] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')));

  assert.equal(await tokens.accessToken('leo@example.com'), 'at-1', 'cached');
  assert.equal(await tokens.accessToken('info@example.org'), 'at-2', 'per subject');
  now += 54 * 60 * 1000;
  assert.equal(await tokens.accessToken('leo@example.com'), 'at-1', 'still cached at 54 min');
  now += 2 * 60 * 1000;
  assert.equal(await tokens.accessToken('leo@example.com'), 'at-3', 'refreshed after 55 min');
  // The allowlist runs before the cache: a mailbox disconnected after its token was cached is refused.
  db.prepare("UPDATE mailboxes SET status = 'disconnected' WHERE id = ?").run(leo);
  await assert.rejects(tokens.accessToken('leo@example.com'), (e) => e.code === 'not_a_delegated_mailbox');
  await assert.rejects(tokens.accessToken('outsider@outside.example'), (e) => e.code === 'domain_not_allowed');
  assert.equal(fetchImpl.calls.length, 3, 'refused subjects never reach Google');
});

test('keyless IAM signer: signJwt with the signer mailbox token, then the same token exchange', async () => {
  const config = { ...base, googleSaEmail: SA, googleSaSignerMailbox: 'leo@example.com' };
  let signed = 0;
  const fetchImpl = fakeFetch([
    ['https://oauth2.googleapis.com/token', (_u, init) => {
      const b = new URLSearchParams(String(init.body));
      if (b.get('grant_type') === 'refresh_token') {
        assert.equal(b.get('refresh_token'), 'gmail-refresh-leo');
        return { json: { access_token: 'impersonator-at', expires_in: 3600 } };
      }
      assert.equal(b.get('assertion'), 'signed.jwt.value');
      return { json: { access_token: 'delegated-at', expires_in: 3600 } };
    }],
    ['https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/', (url, init) => {
      signed++;
      assert.equal(url, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`);
      assert.equal(init.headers.authorization, 'Bearer impersonator-at');
      const claims = JSON.parse(JSON.parse(init.body).payload);
      assert.equal(claims.sub, 'info@example.org');
      assert.equal(claims.iss, SA);
      assert.equal(claims.scope, CALENDAR_SCOPES.join(' '));
      return { json: { keyId: 'k', signedJwt: 'signed.jwt.value' } };
    }],
  ]);
  const signer = signerFromConfig({ db, config, fetchImpl });
  assert.equal(signer.kind, 'iam');
  const tokens = new SaTokens({ db, config, signer, fetchImpl });
  assert.equal(await tokens.accessToken('info@example.org'), 'delegated-at');
  assert.equal(await tokens.accessToken('info@example.org'), 'delegated-at');
  assert.equal(signed, 1);
  await assert.rejects(tokens.accessToken('kit@example.com'), (e) => e.code === 'not_a_delegated_mailbox');
  assert.equal(signed, 1, 'refused subject is never signed');
});

test('keyless IAM signer surfaces Google refusals; signer selection prefers the local key', async () => {
  const fetchImpl = fakeFetch([['https://iamcredentials', () => ({ status: 403, json: { error: { message: 'Permission iam.serviceAccounts.signJwt denied' } } })]]);
  const s = iamSigner({ serviceAccountEmail: SA, impersonatorToken: async () => 'x', fetchImpl });
  await assert.rejects(s.sign({}), (e) => e.code === 'sign_failed' && /403.*signJwt denied/.test(e.message));
  await assert.rejects(mailboxImpersonator({ db, config: base, address: 'nobody@example.com', fetchImpl })(), (e) => e.code === 'no_signer_mailbox');

  assert.equal(signerFromConfig({ db, config: base }), null, 'nothing configured: no signer');
  assert.equal(signerFromConfig({ db, config: { ...base, googleSaKey: KEY_B64, googleSaEmail: SA, googleSaSignerMailbox: 'leo@example.com' } }).kind, 'local');
  assert.equal(signerFromConfig({ db, config: { ...base, googleSaKey: JSON.stringify(KEY_JSON) } }).kind, 'local', 'raw JSON accepted too');
  assert.throws(() => localKeySigner('bm90IGpzb24='), (e) => e.code === 'bad_key');
  await assert.rejects(new SaTokens({ db, config: base, signer: null }).accessToken('leo@example.com'), (e) => e.code === 'not_configured');

  const env = loadConfig({ GOOGLE_SA_DOMAINS: 'example.com,example.org', GOOGLE_SA_EMAIL: SA, GOOGLE_SA_SIGNER_MAILBOX: 'leo@example.com', GOOGLE_SA_KEY: 'k' });
  assert.deepEqual([env.googleSaDomains, env.googleSaEmail, env.googleSaSignerMailbox, env.googleSaKey], ['example.com,example.org', SA, 'leo@example.com', 'k']);
  assert.equal(loadConfig({}).googleSaDomains, '', 'defaults to nobody');
});

// --- calendar client -------------------------------------------------------------------------------

test('calendar client: list pages with syncToken and no timeMin, If-Match on writes, Meet flag, freeBusy, calendars', async () => {
  const API = 'https://www.googleapis.com/calendar/v3';
  const fetchImpl = fakeFetch([[API, (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/events') && init.method === 'GET') {
      return u.searchParams.get('pageToken') ? { json: { items: [{ id: 'e2' }], nextSyncToken: 'sync-2' } } : { json: { items: [{ id: 'e1' }], nextPageToken: 'p2' } };
    }
    if (u.pathname.endsWith('/freeBusy')) return { json: { calendars: { 'a@x': { busy: [{ start: 's', end: 'e' }] } } } };
    if (u.pathname.includes('/events/gone')) return { status: 412, json: { error: { message: 'Precondition Failed' } } };
    if (init.method === 'DELETE') return { status: 204 };
    if (u.pathname.endsWith('/calendarList')) return u.searchParams.get('pageToken') ? { json: { items: [{ id: 'c2' }] } } : { json: { items: [{ id: 'c1' }], nextPageToken: 'n' } };
    return { json: { id: 'new', echo: init.body ? JSON.parse(init.body) : null } };
  }]]);
  const cal = new Calendar({ accessToken: async () => 'AT', fetchImpl });

  const r = await cal.listEvents('leo@example.com', { syncToken: 'sync-1', timeMin: 'ignored' });
  assert.deepEqual(r, { items: [{ id: 'e1' }, { id: 'e2' }], nextSyncToken: 'sync-2' });
  for (const c of fetchImpl.calls) {
    const q = new URL(c.url).searchParams;
    assert.equal(q.get('syncToken'), 'sync-1'); assert.equal(q.get('singleEvents'), 'true'); assert.equal(q.get('timeMin'), null);
    assert.equal(c.headers.authorization, 'Bearer AT');
  }
  fetchImpl.calls.length = 0;
  await cal.listEvents('leo@example.com', { timeMin: '2026-10-08T00:00:00Z', timeMax: '2027-03-07T00:00:00Z' });
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('timeMin'), '2026-10-08T00:00:00Z');
  assert.ok(fetchImpl.calls[0].url.includes('/calendars/leo%40example.com/events'));

  fetchImpl.calls.length = 0;
  await cal.insertEvent('c1', { summary: 'x' }, { conference: true });
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('conferenceDataVersion'), '1');
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('sendUpdates'), 'none');
  await cal.patchEvent('c1', 'e1', { summary: 'y' }, { etag: '"E1"' });
  assert.equal(fetchImpl.calls[1].method, 'PATCH'); assert.equal(fetchImpl.calls[1].headers['if-match'], '"E1"');
  assert.deepEqual(await cal.deleteEvent('c1', 'e1', { etag: '"E2"' }), {});
  assert.equal(fetchImpl.calls[2].headers['if-match'], '"E2"');
  await assert.rejects(cal.patchEvent('c1', 'gone', {}, { etag: '"old"' }), (e) => e instanceof CalendarError && e.status === 412);

  assert.deepEqual(await cal.freeBusy({ timeMin: 'a', timeMax: 'b', ids: ['a@x'] }), { 'a@x': { busy: [{ start: 's', end: 'e' }] } });
  assert.deepEqual((await cal.calendarList()).map((c) => c.id), ['c1', 'c2']);
  assert.equal((await cal.insertCalendar({ summary: 'Tobira 調整中', timeZone: 'Asia/Tokyo' })).echo.summary, 'Tobira 調整中');
  const acl = await cal.insertAcl('c1', { role: 'writer', email: 'leo@example.com' });
  assert.deepEqual(acl.echo, { role: 'writer', scope: { type: 'user', value: 'leo@example.com' } });
});

test('calendarFor: delegated uses the service account, per_mailbox uses calendar_token_enc and never the Gmail token', async () => {
  const seen = [];
  const saTokens = { accessToken: async (sub) => { seen.push(sub); return 'SA-AT'; } };
  const fetchImpl = fakeFetch([
    ['https://oauth2.googleapis.com/token', (_u, init) => ({ json: { access_token: `PM-${new URLSearchParams(String(init.body)).get('refresh_token')}` } })],
    ['https://www.googleapis.com/calendar/v3', () => ({ json: { items: [] } })],
  ]);
  const k = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(leo);
  await calendarFor(k, { db, config: base, saTokens, fetchImpl }).listEvents('primary');
  assert.deepEqual(seen, ['leo@example.com']);
  assert.equal(fetchImpl.calls.at(-1).headers.authorization, 'Bearer SA-AT');

  const s = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(shopBox);
  await assert.rejects(calendarFor(s, { db, config: base, fetchImpl }).listEvents('primary'), /no calendar token/);
  db.prepare('UPDATE mailboxes SET calendar_token_enc = ? WHERE id = ?').run(encrypt('cal-refresh-shop', masterKey), shopBox);
  const s2 = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(shopBox);
  assert.equal(tokenFor(s2, 'calendar', base).refreshToken, 'cal-refresh-shop');
  assert.equal(tokenFor(s2, 'gmail', base).refreshToken, 'gmail-refresh-shop');
  await calendarFor(s2, { db, config: base, saTokens, fetchImpl }).listEvents('primary');
  assert.equal(fetchImpl.calls.at(-1).headers.authorization, 'Bearer PM-cal-refresh-shop');
  assert.deepEqual(seen, ['leo@example.com'], 'per_mailbox never asks the service account');
});

// --- per-mailbox consent ---------------------------------------------------------------------------

let exchangeResult;
async function as(email) {
  exchangeResult = { id_token: idToken(email) };
  const app = buildApp({ db, config: base, exchange: async () => exchangeResult });
  const start = await app.inject('/auth/login');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  return { app, call: (url) => app.inject({ method: 'GET', url, headers: { cookie } }) };
}
const shopBoxRow = () => db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(shopBox);

test('/connect/google/calendar is 404 while calendar_mode is off, 403 for non-owners, 404 for delegated or foreign mailboxes', async () => {
  const owner = await as('owner@shop.jp');
  assert.equal((await owner.call(`/connect/google/calendar?mailbox=${shopBox}`)).statusCode, 404, 'off');
  db.prepare("UPDATE businesses SET calendar_mode = 'shadow' WHERE id = ?").run(shop);
  const staff = await as('staff@shop.jp');
  assert.equal((await staff.call(`/connect/google/calendar?mailbox=${shopBox}`)).statusCode, 403);
  const anon = buildApp({ db, config: base });
  assert.equal((await anon.inject(`/connect/google/calendar?mailbox=${shopBox}`)).statusCode, 403);
  assert.equal((await owner.call(`/connect/google/calendar?mailbox=${leo}`)).statusCode, 404, 'another business\'s mailbox');
  const ok = await owner.call(`/connect/google/calendar?mailbox=${shopBox}`);
  assert.equal(ok.statusCode, 302);
  const u = new URL(ok.headers.location);
  assert.equal(u.searchParams.get('scope'), ['openid', 'email', ...CALENDAR_SCOPES].join(' '));
  assert.equal(u.searchParams.get('login_hint'), 'info@shop.jp');
  assert.equal(u.searchParams.get('include_granted_scopes'), 'true');
  const st = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(u.searchParams.get('state'));
  assert.deepEqual([st.purpose, st.mailbox_id, st.business_id], ['calendar', shopBox, shop]);
  db.prepare("UPDATE businesses SET calendar_access = 'delegated' WHERE id = ?").run(shop);
  assert.equal((await owner.call(`/connect/google/calendar?mailbox=${shopBox}`)).statusCode, 404, 'delegated businesses never consent per mailbox');
});

test('calendar callback writes only calendar_token_enc; rejects a missing id_token and an email mismatch', async () => {
  db.prepare("UPDATE businesses SET calendar_mode = 'shadow' WHERE id = ?").run(shop);
  const owner = await as('owner@shop.jp');
  const before = shopBoxRow();
  const mailboxCount = () => db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n;
  const n0 = mailboxCount();
  const consent = async (tokens) => {
    const start = await owner.call(`/connect/google/calendar?mailbox=${shopBox}`);
    exchangeResult = tokens;
    return owner.call(`/auth/google/callback?code=c&state=${new URL(start.headers.location).searchParams.get('state')}`);
  };

  let r = await consent({ refresh_token: 'cal-r' });
  assert.equal(r.statusCode, 400, 'missing id_token');
  r = await consent({ id_token: idToken('someone-else@shop.jp'), refresh_token: 'cal-r' });
  assert.equal(r.statusCode, 400, 'email mismatch');
  assert.equal(shopBoxRow().calendar_token_enc, null);

  r = await consent({ id_token: idToken('INFO@shop.jp'), refresh_token: 'cal-r' });
  assert.equal(r.statusCode, 302);
  const after = shopBoxRow();
  assert.equal(decrypt(after.calendar_token_enc, masterKey), 'cal-r');
  assert.equal(after.calendar_status, 'ok');
  assert.equal(after.token_enc, before.token_enc, 'Gmail token byte-identical');
  for (const col of ['status', 'mode', 'connected_at', 'oauth_client', 'voice_profile_id', 'address']) assert.equal(after[col], before[col], col);
  assert.equal(mailboxCount(), n0, 'no mailbox created');
});

test('login and mailbox-connect callbacks are unchanged; signer=1 adds only cloud-platform', async () => {
  const app = buildApp({ db, config: base, exchange: async () => ({ id_token: idToken('new@shop.jp'), refresh_token: 'gm-r' }) });
  const start = await app.inject(`/connect/google?business=${shop}&key=ADMIN`);
  const u = new URL(start.headers.location);
  assert.equal(u.searchParams.get('scope'), GMAIL_SCOPES.join(' '), 'default connect URL scopes unchanged');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${u.searchParams.get('state')}`);
  assert.equal(cb.statusCode, 200);
  const m = db.prepare("SELECT * FROM mailboxes WHERE address = 'new@shop.jp'").get();
  assert.equal(decrypt(m.token_enc, masterKey), 'gm-r');
  assert.equal(m.calendar_token_enc, null);

  const signer = new URL((await app.inject(`/connect/google?business=${tobira}&key=ADMIN&signer=1`)).headers.location);
  assert.equal(signer.searchParams.get('scope'), SIGNER_SCOPES.join(' '));
  assert.deepEqual(SIGNER_SCOPES, [...GMAIL_SCOPES, 'https://www.googleapis.com/auth/cloud-platform']);

  const owner = await as('owner@shop.jp');
  assert.equal((await owner.call('/api/me')).statusCode, 200, 'login still works');
});

// --- read-only scripts ------------------------------------------------------------------------------

/** Every local module a file reaches through static imports. */
function localImports(file, seen = new Set()) {
  for (const m of readFileSync(file, 'utf8').matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
    const next = resolve(dirname(file), m[1]);
    if (!seen.has(next)) { seen.add(next); localImports(next, seen); }
  }
  return seen;
}

test('bin/calendar-check imports no send, outbox, ingest, label or Gmail module, even transitively', () => {
  const reached = [...localImports(join(HERE, '..', 'bin', 'calendar-check.js'))].map((p) => basename(p));
  for (const mod of ['send-queue.js', 'cockpit-outbox.js', 'ingest.js', 'mailboxes.js', 'gmail.js', 'app.js', 'worker.js']) assert.ok(!reached.includes(mod), `reaches ${mod}`);
  assert.ok(reached.includes('calendar.js') && reached.includes('sa-token.js'));
});
