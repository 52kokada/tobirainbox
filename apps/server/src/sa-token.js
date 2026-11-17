// apps/server/src/sa-token.js — calendar access tokens for Tobira mailboxes through the service
// account's domain-wide delegation (plan §3, D8, D24).
//
// The JWT is signed by one of two signers; which one runs is a config choice:
//   - local:  GOOGLE_SA_KEY (base64 JSON key) signs RS256 with node:crypto.
//   - iam:    keyless. The org forbids key creation (iam.disableServiceAccountKeyCreation), so the IAM
//             Credentials API signJwt signs for the service account (GOOGLE_SA_EMAIL), called with an
//             access token from GOOGLE_SA_SIGNER_MAILBOX, a connected mailbox whose refresh token
//             carries the cloud-platform scope and whose user holds Service Account Token Creator.
// Delegation reaches every account in the domain, so assertDelegable is the boundary: the subject must
// be a connected mailbox of a 'delegated' business whose domain is in GOOGLE_SA_DOMAINS.
import { createSign } from 'node:crypto';
import { CALENDAR_SCOPES, refreshAccessToken } from './google.js';
import { tokenFor } from './token-source.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const IAM_SIGN = (email) => `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signJwt`;
const CACHE_MS = 55 * 60 * 1000;
const JWT_LIFETIME_S = 3600;

export class SaTokenError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

export const saDomains = (config) => String(config.googleSaDomains ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

/** The claims Google's token endpoint expects for a delegated assertion. */
export function jwtClaims({ serviceAccountEmail, subject, scopes = CALENDAR_SCOPES, nowS = Math.floor(Date.now() / 1000) }) {
  return { iss: serviceAccountEmail, sub: subject, scope: scopes.join(' '), aud: TOKEN_URL, iat: nowS, exp: nowS + JWT_LIFETIME_S };
}

/** Refuses any subject that is not a connected mailbox of a delegated business in an allowed domain. */
export function assertDelegable(db, config, subject) {
  const address = String(subject ?? '').trim().toLowerCase();
  const domain = address.split('@')[1] ?? '';
  if (!domain || !saDomains(config).includes(domain)) throw new SaTokenError('domain_not_allowed', `${address || '(empty)'} is outside GOOGLE_SA_DOMAINS`);
  const row = db.prepare(`SELECT m.id FROM mailboxes m JOIN businesses b ON b.id = m.business_id
      WHERE lower(m.address) = ? AND m.status = 'connected' AND b.calendar_access = 'delegated' LIMIT 1`).get(address);
  if (!row) throw new SaTokenError('not_a_delegated_mailbox', `${address} is not a connected mailbox of a delegated business`);
  return address;
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** Signer (a): a JSON key from GOOGLE_SA_KEY (base64 or raw JSON). */
export function localKeySigner(keyB64OrJson) {
  const raw = String(keyB64OrJson ?? '').trim();
  let key;
  try { key = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); }
  catch { throw new SaTokenError('bad_key', 'GOOGLE_SA_KEY is not a service account JSON key'); }
  if (!key.client_email || !key.private_key) throw new SaTokenError('bad_key', 'GOOGLE_SA_KEY lacks client_email or private_key');
  return {
    kind: 'local',
    serviceAccountEmail: key.client_email,
    async sign(claims) {
      const head = b64url({ alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) });
      const input = `${head}.${b64url(claims)}`;
      const sig = createSign('RSA-SHA256').update(input).end().sign(key.private_key).toString('base64url');
      return `${input}.${sig}`;
    },
  };
}

/** Signer (b): keyless, IAM Credentials signJwt with the impersonator's access token. */
export function iamSigner({ serviceAccountEmail, impersonatorToken, fetchImpl = fetch }) {
  if (!serviceAccountEmail) throw new SaTokenError('not_configured', 'GOOGLE_SA_EMAIL is required for keyless signing');
  return {
    kind: 'iam',
    serviceAccountEmail,
    async sign(claims) {
      const res = await fetchImpl(IAM_SIGN(serviceAccountEmail), {
        method: 'POST',
        headers: { authorization: `Bearer ${await impersonatorToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ payload: JSON.stringify(claims) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.signedJwt) throw new SaTokenError('sign_failed', `iam signJwt ${res.status}: ${json.error?.message ?? ''}`.trim());
      return json.signedJwt;
    },
  };
}

/** An access-token function for the signer mailbox (its refresh token must carry cloud-platform). */
export function mailboxImpersonator({ db, config, address, fetchImpl = fetch, now = Date.now }) {
  let cached = null;
  return async () => {
    if (cached && now() < cached.expiresAt) return cached.token;
    const mbx = db.prepare("SELECT * FROM mailboxes WHERE lower(address) = ? AND status = 'connected' AND token_enc IS NOT NULL LIMIT 1")
      .get(String(address).toLowerCase());
    if (!mbx) throw new SaTokenError('no_signer_mailbox', `signer mailbox ${address} is not connected`);
    const t = await refreshAccessToken({ ...tokenFor(mbx, 'gmail', config), fetchImpl });
    cached = { token: t.access_token, expiresAt: now() + Math.min(CACHE_MS, ((t.expires_in ?? 3600) - 60) * 1000) };
    return cached.token;
  };
}

/** The signer the config selects: the local key if present, else keyless IAM, else null (calendar off). */
export function signerFromConfig({ db, config, fetchImpl = fetch }) {
  if (config.googleSaKey) return localKeySigner(config.googleSaKey);
  if (config.googleSaSignerMailbox && config.googleSaEmail) {
    return iamSigner({ serviceAccountEmail: config.googleSaEmail, fetchImpl,
      impersonatorToken: mailboxImpersonator({ db, config, address: config.googleSaSignerMailbox, fetchImpl }) });
  }
  return null;
}

/** Access tokens per subject, cached 55 minutes. */
export class SaTokens {
  constructor({ db, config, signer, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { db, config, signer, fetchImpl, now });
    this.cache = new Map();
  }

  async accessToken(subject) {
    const sub = assertDelegable(this.db, this.config, subject);
    const hit = this.cache.get(sub);
    if (hit && this.now() < hit.expiresAt) return hit.token;
    if (!this.signer) throw new SaTokenError('not_configured', 'no service account signer configured');
    const assertion = await this.signer.sign(jwtClaims({ serviceAccountEmail: this.signer.serviceAccountEmail, subject: sub, nowS: Math.floor(this.now() / 1000) }));
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new SaTokenError('token_failed', `sa token ${res.status}: ${json.error ?? ''} ${json.error_description ?? ''}`.trim());
    this.cache.set(sub, { token: json.access_token, expiresAt: this.now() + CACHE_MS });
    return json.access_token;
  }
}
