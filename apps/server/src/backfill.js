// apps/server/src/backfill.js — the full history of a mailbox, so 履歴 shows every conversation, not only the
// mail that arrived after connecting. Read-only on Gmail. Old conversations land as 送信済み (we wrote last) or
// 完了 (they wrote last), never back in 要対応. Each inbound message is marked seen so the worker skips it.
import { sortMessage, parseFrom } from '@tobira-inbox/engine';
import { parseMessage } from './gmail.js';
import { ownMatcher } from './ingest.js';
import { underDailyCap } from './ingest-cap.js';
import { Store } from './store.js';

const META = ['From', 'To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted', 'X-Autoreply', 'Reply-To'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function backfillMailbox({ db, mailbox, gmail, ai, config = {}, maxThreads = 20000, onProgress = () => {} }) {
  const store = new Store(db, mailbox.business_id);
  const labels = store.labels();
  const isOwn = ownMatcher(db, mailbox.business_id);
  const known = db.prepare('SELECT 1 FROM threads WHERE mailbox_id = ? AND gmail_thread_id = ?');
  const markSeen = db.prepare("INSERT OR IGNORE INTO seen_messages (mailbox_id, gmail_message_id, outcome) VALUES (?, ?, 'skipped')");
  const insert = db.prepare(`INSERT OR IGNORE INTO threads (id, business_id, mailbox_id, gmail_thread_id, last_message_id, last_rfc_message_id,
      label_key, label_confidence, label_by, status, cache_from, cache_subject, cache_snippet, last_message_at, updated_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const out = { listed: 0, added: 0, skipped: 0, noInbound: 0, errors: 0 };
  const aiMetered = ai && { complete: (req) => ai.complete({ ...req, meter: { businessId: mailbox.business_id, mailboxId: mailbox.id } }) };
  let pageToken;
  do {
    const q = new URLSearchParams({ q: '-in:spam -in:trash -in:chats', maxResults: '500' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await gmail.call('GET', `/threads?${q}`);
    pageToken = page.nextPageToken;
    for (const { id } of page.threads ?? []) {
      if (out.listed >= maxThreads) { pageToken = null; break; }
      out.listed += 1;
      if (known.get(mailbox.id, id)) { out.skipped += 1; continue; }
      try {
        const meta = new URLSearchParams({ format: 'metadata' });
        for (const h of META) meta.append('metadataHeaders', h);
        const raw = await gmail.call('GET', `/threads/${id}?${meta}`);
        const msgs = (raw.messages ?? []).map(parseMessage).filter((m) => !m.reaction && !m.labelIds.includes('DRAFT'));
        const inbound = msgs.filter((m) => !m.labelIds.includes('SENT') && !isOwn(parseFrom(m.from)));
        if (!inbound.length) { out.noInbound += 1; continue; } // only our own outreach, nobody wrote back
        const lastIn = inbound.at(-1); const last = msgs.at(-1);
        const weWroteLast = last.labelIds.includes('SENT') || isOwn(parseFrom(last.from));
        const sorted = await sortMessage({ msg: lastIn, labels, ai: aiMetered,
          allowModel: () => Boolean(aiMetered) && underDailyCap(db, mailbox.business_id, config.aiDailyCapUsd) });
        db.transaction(() => {
          insert.run(mailbox.business_id, mailbox.id, id, lastIn.id, lastIn.messageId || null, sorted.label, sorted.confidence, sorted.by,
            weWroteLast ? 'sent' : 'done', lastIn.from, lastIn.subject, (lastIn.snippet ?? '').slice(0, 300),
            last.internalDate ?? lastIn.internalDate ?? new Date().toISOString(), new Date().toISOString());
          for (const m of inbound) markSeen.run(mailbox.id, m.id);
        })();
        out.added += 1;
      } catch (err) {
        out.errors += 1;
        if (/429|rate/i.test(String(err.message))) await pause(5000);
      }
      if (out.listed % 50 === 0) onProgress({ mailbox: mailbox.address, ...out });
      await pause(60); // stay well inside Gmail's per-user quota
    }
  } while (pageToken);
  return out;
}
