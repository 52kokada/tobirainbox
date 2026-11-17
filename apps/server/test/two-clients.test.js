// Two Google OAuth clients: example.com mailboxes stay on the internal client; outside
// businesses (invite sign-up) use the external one, and each mailbox refreshes with its own client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { newId } from '../src/store.js';
import { encrypt } from '../src/crypto.js';
import { buildApp } from '../src/app.js';
import { googleClient, loginClient } from '../src/config.js';
import { gmailFor } from '../src/mailboxes.js';

const masterKey = randomBytes(32).toString('base64');
const base = { clientId: 'INT', clientSecret: 'int-s', masterKey, publicUrl: 'https://inbox.example.com', adminToken: 'ADMIN', aiDailyCapUsd: 0.5 };
const ext = { ...base, extClientId: 'EXT', extClientSecret: 'ext-s' };
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url')}.y`;

test('without an external client everything stays internal (today)', () => {
  assert.equal(googleClient(base, 'external').which, 'internal');
  assert.equal(loginClient(base), 'internal');
  assert.equal(googleClient(ext, 'external').clientId, 'EXT');
  assert.equal(loginClient(ext), 'internal', 'plain sign-in stays internal: the external project is in Testing');
  assert.equal(loginClient(ext, { outside: true }), 'external');
});

test('a mailbox refreshes with the client that issued its token', () => {
  const seen = [];
  const f = (o) => { seen.push(o.clientId); return {}; };
  gmailFor({ token_enc: encrypt('r', masterKey) }, ext, f);
  gmailFor({ token_enc: encrypt('r', masterKey), oauth_client: 'external' }, ext, f);
  assert.deepEqual(seen, ['INT', 'EXT']);
});

test('invite sign-up makes an external business; its mailbox connects and is stored as external', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO businesses (id, name, status) VALUES ('tobira', 'Example Studio', 'active')").run();
  db.prepare("INSERT INTO invites (code, note) VALUES ('CODE1', '東京クッキングスタジオ')").run();
  const used = [];
  const app = buildApp({ db, config: ext, exchange: async (o) => { used.push(o.clientId); return { id_token: idToken('hello@acme-shop.example'), refresh_token: 'rt' }; } });
  const start = await app.inject('/signup?code=CODE1');
  assert.match(start.headers.location, /client_id=EXT/);
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await app.inject(`/auth/google/callback?code=x&state=${state}`);
  const cookie = String(cb.headers['set-cookie'] ?? '').split(';')[0];
  const biz = db.prepare("SELECT id, oauth_client FROM businesses WHERE name = '東京クッキングスタジオ'").get();
  assert.equal(biz.oauth_client, 'external');

  const conn = await app.inject({ url: '/connect/google/me?back=setup', headers: { cookie } });
  assert.match(conn.headers.location, /client_id=EXT/);
  const st2 = new URL(conn.headers.location).searchParams.get('state');
  await app.inject(`/auth/google/callback?code=y&state=${st2}`);
  assert.equal(db.prepare('SELECT oauth_client FROM mailboxes WHERE business_id = ?').get(biz.id).oauth_client, 'external');
  assert.deepEqual(used, ['EXT', 'EXT']);

  // Tobira's own business keeps connecting through the internal client.
  const own = await app.inject('/connect/google?business=tobira&key=ADMIN');
  assert.match(own.headers.location, /client_id=INT/);
});
