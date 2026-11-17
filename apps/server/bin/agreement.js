// node apps/server/bin/agreement.js <tobira-inbox.db> <cockpit.db> [days]
// Phase 2 exit check: for replies both systems saw (same Gmail message id),
// does TobirAInbox's label agree with CRM's verdict? Opens both databases
// READ-ONLY; meant to be run by root (a timer), never by the app service.
import Database from 'better-sqlite3';
import { labelForOutreachVerdict } from '@tobira-inbox/engine';

export function agreement(inboxDb, cockpitDb, days = 14) {
  const cols = cockpitDb.prepare("SELECT name FROM pragma_table_info('replies')").all().map((r) => r.name);
  const verdictCol = cols.includes('verdict') ? 'verdict' : 'classified_as';
  if (!cols.includes('gmail_message_id')) throw new Error('cockpit replies has no gmail_message_id');
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const ours = inboxDb.prepare('SELECT gmail_message_id, label_key, label_by FROM message_labels WHERE at >= ?').all(since);
  const theirs = new Map(cockpitDb.prepare(`SELECT gmail_message_id, ${verdictCol} AS verdict FROM replies WHERE gmail_message_id IS NOT NULL`)
    .all().map((r) => [r.gmail_message_id, String(r.verdict ?? '').toLowerCase()]));
  // CRM only judges replies to outreach; compare on those messages only.
  const pairs = ours.filter((o) => theirs.has(o.gmail_message_id)).map((o) => {
    const v = theirs.get(o.gmail_message_id);
    const expected = labelForOutreachVerdict(v);
    // 'positive' is any reply that wants to continue: inquiry, question or booking all count.
    const agree = v === 'positive' ? ['inquiry', 'question', 'booking'].includes(o.label_key) : o.label_key === expected;
    return { id: o.gmail_message_id, cockpit: v, ours: o.label_key, by: o.label_by, agree };
  });
  const agreed = pairs.filter((p) => p.agree).length;
  return {
    days, sortedByUs: ours.length, comparable: pairs.length, agreed,
    rate: pairs.length ? Math.round((agreed / pairs.length) * 1000) / 10 : null,
    target: 95,
    mismatches: pairs.filter((p) => !p.agree).slice(0, 50),
  };
}

if (process.argv[1]?.endsWith('agreement.js')) {
  const [inboxPath, cockpitPath, days] = process.argv.slice(2);
  if (!inboxPath || !cockpitPath) { console.error('usage: agreement.js <tobira-inbox.db> <cockpit.db> [days]'); process.exit(2); }
  const a = new Database(inboxPath, { readonly: true, fileMustExist: true });
  const b = new Database(cockpitPath, { readonly: true, fileMustExist: true });
  console.log(JSON.stringify({ at: new Date().toISOString(), ...agreement(a, b, Number(days ?? 14)) }));
}
