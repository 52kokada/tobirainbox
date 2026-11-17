// apps/server/worker.js — loops in one process:
//  • every POLL_SECONDS (60): check connected mailboxes, sort new mail, draft, retry drafts, and (calendar not off)
//    detect dates in new and sent mail, retrying detections the date sub-cap deferred on an earlier day.
//  • every 5 s: deliver sends whose undo window has closed (only ever created by a person's click), then send
//    the Google invites of confirmation emails just delivered (calendar step 15).
//  • every POLL_SECONDS: read-sync Google calendars of businesses whose calendar_mode is not 'off', then the
//    hold pass: place holds for our own offers, flag hand-edited holds, expire past or silent ones (step 11).
//  • every 5 min: read CRM's outreach follow-ups and stamp threads (営業の返信 / フォローアップ, outreach.js).
import { join } from 'node:path';
import { openDb } from './src/db.js';
import { loadConfig, missing } from './src/config.js';
import { createAi } from './src/ai.js';
import { ingestAll, retryDeferredDates } from './src/ingest.js';
import { deliverDue } from './src/send-queue.js';
import { gmailTransport } from './src/transport.js';
import { configurePush, notifyNew } from './src/push.js';
import { emit, flushOutbox } from './src/cockpit-outbox.js';
import { syncOutreach } from './src/outreach.js';
import { draftOnRequest } from './src/drafting.js';
import { gmailFor } from './src/mailboxes.js';
import { learnFromSent, proposeRulesWeekly } from './src/learning.js';
import { rereadWebsites } from './src/website.js';
import { raiseAlert, resolveAlerts } from './src/alerts.js';
import { calendarFor } from './src/calendar.js';
import { calendarPass } from './src/calendar-sync.js';
import { holdPassAll } from './src/suggestions.js';
import { sendDueInvites } from './src/meetings.js';
import { SaTokens, signerFromConfig } from './src/sa-token.js';

const config = loadConfig();
const lack = missing(config, ['clientId', 'clientSecret', 'masterKey', 'anthropicApiKey']);
if (lack.length) {
  console.error(`worker: not configured, missing ${lack.join(', ')}`);
  process.exit(2);
}

const db = openDb(join(config.dataDir, 'tobira-inbox.db'));
// db given: every billed Claude call is written to ai_usage centrally (spend tracking).
const ai = createAi({ apiKey: config.anthropicApiKey, db });
const transport = gmailTransport(db, config);
const pushOn = configurePush(config);
// A bad GOOGLE_SA_KEY must never stop mail: calendar sync then fails per pass and alerts instead.
let saSigner = null;
try { saSigner = signerFromConfig({ db, config }); } catch (err) { console.error(`calendar signer not usable: ${err.message}`); }
const saTokens = saSigner ? new SaTokens({ db, config, signer: saSigner }) : null;
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

let nextIngest = 0;
let nextCalendar = 0;
let nextOutreach = 0;
let nextWeekly = Date.now() + 5 * 60_000;
while (!stopping) {
  try {
    const sent = await deliverDue(db, transport, {
      onSent: ({ send, thread, mailbox, delivered }) => {
        emit(db, {
          businessId: send.business_id, type: 'sent', mailbox: mailbox.address, thread: thread.gmail_thread_id, gmailMessageId: delivered.messageId,
          label: thread.label_key, extra: { messageIdHeader: delivered.messageIdHeader, inReplyTo: delivered.inReplyTo, toEmail: delivered.to, replyingToGmailMessageId: delivered.replyingTo },
        });
        try { learnFromSent(db, { send, thread, mailbox, delivered }); } catch (err) { console.error(`learn from sent failed: ${err.message}`); }
      },
    });
    if (sent.length) console.log(JSON.stringify({ at: new Date().toISOString(), sends: sent }));
  } catch (err) {
    console.error(`send pass failed: ${err.message}`);
  }
  // Google invites of confirmation emails delivered above (D41, D50). Its own block: an invite failure never
  // touches the email, and nothing runs for businesses with calendar_mode 'off'.
  try {
    const inv = await sendDueInvites({ db, clientFor: (m) => calendarFor(m, { db, config, saTokens }) });
    if (inv.length) console.log(JSON.stringify({ at: new Date().toISOString(), invites: inv }));
  } catch (err) { console.error(`invite pass failed: ${err.message}`); }
  if (Date.now() >= nextIngest) {
    nextIngest = Date.now() + config.pollSeconds * 1000;
    try {
      const results = await ingestAll({ db, ai, config });
      const busy = results.filter((r) => r.checked || r.error || r.retriedDrafts);
      if (busy.length) console.log(JSON.stringify({ at: new Date().toISOString(), results: busy }));
      // Date detections the sub-cap deferred on an earlier day (calendar step 9); none while calendar_mode is off.
      const dd = await retryDeferredDates({ db, ai, config });
      if (dd.retried || dd.failed) console.log(JSON.stringify({ at: new Date().toISOString(), deferredDates: dd }));
      const ob = await flushOutbox(db, config);
      if (ob.delivered || ob.error) console.log(JSON.stringify({ at: new Date().toISOString(), cockpit: ob }));
      // Its own try: CRM being down never stops mail.
      if (Date.now() >= nextOutreach) {
        nextOutreach = Date.now() + 5 * 60_000;
        try {
          const o = await syncOutreach(db, config, {
            draftThread: async (id) => {
              const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
              const mailbox = thread && db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(thread.mailbox_id);
              return mailbox ? draftOnRequest({ db, mailbox, gmail: gmailFor(mailbox, config), ai, thread, config }) : null;
            },
          });
          if (o.businesses?.some((b) => b.cleared || b.seeded || b.drafted)) console.log(JSON.stringify({ at: new Date().toISOString(), outreach: o.businesses }));
        } catch (err) { console.error(`outreach sync failed: ${err.message}`); }
      }
      if (pushOn) {
        const n = await notifyNew(db);
        if (n.notified || n.failed) console.log(JSON.stringify({ at: new Date().toISOString(), push: n }));
      }
    } catch (err) {
      console.error(`worker pass failed: ${err.message}`);
    }
    // Weekly jobs (cheap checks every pass; work only when due): re-read websites (D8), propose rules (D21).
    if (Date.now() >= nextWeekly) {
      nextWeekly = Date.now() + 60 * 60_000;
      try {
        const w = await rereadWebsites({ db, ai, config });
        const r = await proposeRulesWeekly(db, { ai, config });
        if (w || r) console.log(JSON.stringify({ at: new Date().toISOString(), weekly: { websites: w, rules: r } }));
      } catch (err) { console.error(`weekly pass failed: ${err.message}`); }
    }
  }
  // Calendar read sync: its own block, no shared path with deliverDue or flushOutbox. Businesses with
  // calendar_mode 'off' (every business until switch-on) are skipped inside calendarPass.
  if (Date.now() >= nextCalendar) {
    nextCalendar = Date.now() + config.pollSeconds * 1000;
    try {
      const cal = await calendarPass({ db, clientFor: (m) => calendarFor(m, { db, config, saTokens }), alerts: { raise: raiseAlert, resolve: resolveAlerts } });
      const notable = cal.filter((r) => !r.ok || r.full);
      if (notable.length) console.log(JSON.stringify({ at: new Date().toISOString(), calendar: notable }));
    } catch (err) { console.error(`calendar pass failed: ${err.message}`); }
    // After the read sync, so hand edits are judged against fresh etags. Writes only via calendar-writes.js.
    try {
      const holds = await holdPassAll({ db, clientFor: (m) => calendarFor(m, { db, config, saTokens }) });
      const busy = holds.filter((r) => r.error || r.placed || r.expired || r.flagged || r.errors);
      if (busy.length) console.log(JSON.stringify({ at: new Date().toISOString(), holds: busy }));
    } catch (err) { console.error(`hold pass failed: ${err.message}`); }
  }
  for (let waited = 0; waited < 5000 && !stopping; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
}
db.close();
