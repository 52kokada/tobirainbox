// apps/server/src/crypto.js — AES-256-GCM for OAuth tokens at rest.
// SECRETS_MASTER_KEY: 32 random bytes, base64, only in /opt/tobira-inbox/.env.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(masterKey) {
  const k = Buffer.from(String(masterKey ?? ''), 'base64');
  if (k.length !== 32) throw new Error('SECRETS_MASTER_KEY must be 32 bytes (base64)');
  return k;
}

export function encrypt(plain, masterKey) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(masterKey), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function decrypt(blob, masterKey) {
  const [v, iv, tag, body] = String(blob).split(':');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(masterKey), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}
