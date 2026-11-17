// apps/server/src/token-source.js — where a mailbox's Google credentials come from, per purpose.
// Callers never read token columns themselves. Kept free of Gmail, send and outbox imports so the
// read-only bin/ scripts can use it.
import { googleClient } from './config.js';
import { decrypt } from './crypto.js';

/**
 * 'gmail' reads token_enc; 'calendar' reads calendar_token_enc (per-mailbox consent, plan §3), never the
 * Gmail token. Delegated businesses get calendar tokens from sa-token.js instead (calendar.js picks).
 */
export function tokenFor(mailbox, purpose, config) {
  const column = { gmail: 'token_enc', calendar: 'calendar_token_enc' }[purpose];
  if (!column) throw new Error(`no token source for purpose ${purpose}`);
  if (!mailbox[column]) throw new Error(`mailbox has no ${purpose} token`);
  const { clientId, clientSecret } = googleClient(config, mailbox.oauth_client);
  return { clientId, clientSecret, refreshToken: decrypt(mailbox[column], config.masterKey) };
}
