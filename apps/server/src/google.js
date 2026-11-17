// apps/server/src/google.js — Google OAuth (web server flow) for connecting a
// Gmail mailbox. Scopes per plan Phase 0; send is requested now so a mailbox
// never has to be re-consented when it goes live (sending still needs a click).
export const GMAIL_SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

// Calendar tab (plan §3): the narrowest scopes that cover the decisions. Requested by /connect/google/calendar
// (per-mailbox businesses) and granted to the service account's domain-wide delegation.
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

// Keyless service-account signing (sa-token.js iam signer): the signer mailbox's consent adds this so its
// token may call IAM Credentials signJwt. Requested only by the admin /connect/google?signer=1 link.
export const SIGNER_SCOPES = [...GMAIL_SCOPES, 'https://www.googleapis.com/auth/cloud-platform'];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function authUrl({ clientId, redirectUri, state, loginHint, scopes = GMAIL_SCOPES }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) q.set('login_hint', loginHint);
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(body, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`google token error ${res.status}: ${json.error ?? ''} ${json.error_description ?? ''}`.trim());
  return json;
}

export function exchangeCode({ clientId, clientSecret, redirectUri, code, fetchImpl = fetch }) {
  return tokenRequest({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code, grant_type: 'authorization_code' }, fetchImpl);
}

export function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  return tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchImpl);
}

/** Email address from the id_token (signature already guaranteed by TLS to Google's token endpoint). */
export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload.email_verified === false ? null : String(payload.email ?? '').toLowerCase() || null;
  } catch { return null; }
}
