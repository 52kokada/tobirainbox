// Calendar plan step 2: Google scopes and mailbox tokens sit behind named constants and one
// token source. Nothing a person sees may change: the connect URL stays byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authUrl, GMAIL_SCOPES, CALENDAR_SCOPES } from '../src/google.js';
import { tokenFor } from '../src/token-source.js';
import { gmailFor } from '../src/mailboxes.js';
import { encrypt } from '../src/crypto.js';

// Captured from origin/main before the refactor.
const BEFORE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Finbox.example.com%2Fauth%2Fgoogle%2Fcallback&response_type=code&scope=openid+email+profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send&access_type=offline&prompt=consent&include_granted_scopes=true&state=st4te&login_hint=leo%40example.com';
const BEFORE_NO_HINT = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&redirect_uri=https%3A%2F%2Fx%2Fcb&response_type=code&scope=openid+email+profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send&access_type=offline&prompt=consent&include_granted_scopes=true&state=s';

test('authUrl without scopes is byte-identical to the pre-refactor /connect/google URL', () => {
  assert.equal(authUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'https://inbox.example.com/auth/google/callback', state: 'st4te', loginHint: 'leo@example.com' }), BEFORE);
  assert.equal(authUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 's' }), BEFORE_NO_HINT);
  assert.equal(authUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 's', scopes: GMAIL_SCOPES }), BEFORE_NO_HINT);
});

test('calendar scopes are separate and never in the default request', () => {
  const scope = new URL(BEFORE).searchParams.get('scope');
  for (const s of CALENDAR_SCOPES) assert.ok(!scope.includes(s));
  const cal = new URL(authUrl({ clientId: 'c', redirectUri: 'https://x/cb', state: 's', scopes: ['openid', 'email', ...CALENDAR_SCOPES] }));
  assert.equal(cal.searchParams.get('scope'), ['openid', 'email', ...CALENDAR_SCOPES].join(' '));
});

test('tokenFor gmail gives the mailbox own client and decrypted token; gmailFor uses it', () => {
  const masterKey = Buffer.alloc(32, 7).toString('base64');
  const config = { masterKey, clientId: 'int', clientSecret: 'int-s', extClientId: 'ext', extClientSecret: 'ext-s' };
  const mbx = { token_enc: encrypt('refresh-1', masterKey) };
  const t = tokenFor(mbx, 'gmail', config);
  assert.equal(t.clientId, 'int');
  assert.equal(tokenFor({ ...mbx, oauth_client: 'external' }, 'gmail', config).clientId, 'ext');
  assert.equal(t.refreshToken, 'refresh-1');
  let seen; gmailFor(mbx, config, (o) => { seen = o; });
  assert.deepEqual(seen, t);
  // Step 4: 'calendar' reads only calendar_token_enc; a mailbox without one has no calendar token.
  assert.throws(() => tokenFor(mbx, 'calendar', config), /no calendar token/);
  assert.equal(tokenFor({ ...mbx, calendar_token_enc: encrypt('cal-1', masterKey) }, 'calendar', config).refreshToken, 'cal-1');
  assert.throws(() => tokenFor(mbx, 'drive', config), /no token source/);
});
