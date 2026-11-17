// apps/server/src/config.js — everything from the environment (/opt/tobira-inbox/.env).
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8960),
    host: env.HOST ?? '127.0.0.1',
    dataDir: env.DATA_DIR ?? './data',
    publicUrl: (env.PUBLIC_URL ?? 'https://inbox.example.com').replace(/\/$/, ''),
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    // Outside businesses (External project "TobirAInbox"). Empty = everyone uses the internal client.
    extClientId: env.GOOGLE_EXT_CLIENT_ID ?? '',
    extClientSecret: env.GOOGLE_EXT_CLIENT_SECRET ?? '',
    masterKey: env.SECRETS_MASTER_KEY ?? '',
    adminToken: env.ADMIN_TOKEN ?? '',
    // Tobira Manager (Discord) endpoints act on this one business only (calendar step 18, D32). Empty = off.
    managerBusinessId: env.MANAGER_BUSINESS_ID ?? '',
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
    pollSeconds: Number(env.POLL_SECONDS ?? 60),
    // Hard ceiling on AI spend per business per day (USD); 0 disables the cap.
    aiDailyCapUsd: Number(env.AI_DAILY_CAP_USD ?? 0.5),
    cockpitEventsUrl: env.COCKPIT_EVENTS_URL ?? '',
    cockpitEventsToken: env.COCKPIT_EVENTS_TOKEN ?? '',
    // Optional CRM tenant slug for the outreach follow-ups feed (?tenant=); empty = every tenant.
    cockpitTenant: env.COCKPIT_TENANT ?? '',
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY ?? '',
    // Calendar via domain-wide delegation (plan §3, step 4). One signer is used: GOOGLE_SA_KEY (base64 JSON
    // key) if set, else keyless IAM signJwt for GOOGLE_SA_EMAIL using GOOGLE_SA_SIGNER_MAILBOX's token.
    // GOOGLE_SA_DOMAINS (comma list) bounds which addresses may be impersonated; empty = none.
    googleSaKey: env.GOOGLE_SA_KEY ?? '',
    googleSaEmail: env.GOOGLE_SA_EMAIL ?? '',
    googleSaSignerMailbox: env.GOOGLE_SA_SIGNER_MAILBOX ?? '',
    googleSaDomains: env.GOOGLE_SA_DOMAINS ?? '',
    vapidSubject: env.VAPID_SUBJECT ?? 'mailto:leo@example.com',
  };
}

export function missing(config, keys) {
  return keys.filter((k) => !config[k]);
}

/** Google OAuth client: 'internal' (example.com) or 'external' (outside businesses); falls back to internal. */
export function googleClient(config, which = 'internal') {
  if (which === 'external' && config.extClientId && config.extClientSecret) {
    return { clientId: config.extClientId, clientSecret: config.extClientSecret, which: 'external' };
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret, which: 'internal' };
}

/**
 * Which client signs a person in. Plain sign-in stays internal (example.com staff), because the external
 * project is in Testing and refuses anyone not listed as a test user. Invite sign-ups and the outside
 * sign-in link (/auth/login?outside=1) use the external client once it exists.
 */
export const loginClient = (config, { outside = false } = {}) =>
  (outside && config.extClientId && config.extClientSecret ? 'external' : 'internal');
