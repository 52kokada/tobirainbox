// apps/server/src/copies.js — one email can reach several of our mailboxes (CC); they are handled as one.
// The same email in another of our mailboxes (CC) follows the one we handled.
export function closeCopies(db, threadId, status) {
  const t = db.prepare('SELECT business_id, last_rfc_message_id FROM threads WHERE id = ?').get(threadId);
  if (!t?.last_rfc_message_id) return 0;
  const to = status === 'new' ? 'new' : 'done';
  const from = status === 'new' ? "('done')" : "('new','drafted')";
  // A copy holding a scheduled reply (予約送信) is never closed by its twin: its reply is still going out.
  return db.prepare(`UPDATE threads SET status = ?, updated_at = ? WHERE business_id = ? AND last_rfc_message_id = ? AND id != ? AND status IN ${from}
      AND NOT EXISTS (SELECT 1 FROM sends s JOIN drafts d ON d.id = s.draft_id WHERE d.thread_id = threads.id AND s.status = 'queued' AND s.scheduled_at IS NOT NULL)`)
    .run(to, new Date().toISOString(), t.business_id, t.last_rfc_message_id, threadId).changes;
}
