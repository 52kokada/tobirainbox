// apps/server/src/questions.js — ask the owner to fill a 【要確認】 (D23).
// Push + console stand in for LINE until the LINE account exists; the answer fills
// the blank in the draft and, when asked, is saved as a fact for next time.
import { findBlanks, fillBlank } from '@tobira-inbox/engine';
import { newId, Store } from './store.js';
import { notifyOwners } from './push.js';

export async function askOwner(db, { businessId, threadId, blank, userId, pushSend }) {
  const store = new Store(db, businessId);
  const thread = store.thread(threadId);
  if (!thread) return { error: 'not found', code: 404 };
  const draft = store.latestDraft(threadId);
  if (!draft || !findBlanks(draft.body_text).some((b) => b.text === blank)) return { error: 'no such blank', code: 400 };
  const open = db.prepare('SELECT id FROM owner_questions WHERE business_id = ? AND thread_id = ? AND blank = ? AND answer IS NULL').get(businessId, threadId, blank);
  if (open) return { id: open.id, again: true };
  const id = newId();
  db.prepare('INSERT INTO owner_questions (id, business_id, draft_id, thread_id, blank, question, asked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, businessId, draft.id, threadId, blank, blank, userId, new Date().toISOString());
  store.audit(userId, 'owner_question', id);
  try {
    await notifyOwners(db, businessId, { title: `質問｜${blank}`, body: thread.cache_subject ?? '', url: `/#q=${id}`, tag: `q-${id}` }, pushSend ? { send: pushSend } : {});
  } catch { /* push is best effort; the question is visible in the console */ }
  return { id };
}

export function openQuestions(db, businessId) {
  return db.prepare(`SELECT q.id, q.blank, q.thread_id AS threadId, q.created_at AS createdAt, u.email AS askedBy, t.cache_subject AS subject, t.cache_from AS sender
    FROM owner_questions q LEFT JOIN users u ON u.id = q.asked_by LEFT JOIN threads t ON t.id = q.thread_id
    WHERE q.business_id = ? AND q.answer IS NULL ORDER BY q.created_at DESC`).all(businessId);
}

export function answerQuestion(db, { businessId, id, answer, saveFact = true, factKey, userId }) {
  const q = db.prepare('SELECT * FROM owner_questions WHERE id = ? AND business_id = ?').get(id, businessId);
  if (!q) return { error: 'not found', code: 404 };
  if (q.answer != null) return { error: 'already answered', code: 409 };
  const text = String(answer ?? '').trim();
  if (!text) return { error: 'empty answer', code: 400 };
  const store = new Store(db, businessId);
  let filled = false;
  db.transaction(() => {
    db.prepare('UPDATE owner_questions SET answer = ?, answered_at = ?, answered_by = ?, fact_key = ? WHERE id = ?')
      .run(text, new Date().toISOString(), userId, saveFact ? (factKey || q.blank) : null, id);
    const draft = q.thread_id ? store.latestDraft(q.thread_id) : null;
    if (draft && findBlanks(draft.body_text).some((b) => b.text === q.blank)) {
      const body = fillBlank(draft.body_text, q.blank, text);
      const newIdv = store.saveDraft({ threadId: q.thread_id, bodyText: body, blanks: findBlanks(body).map((b) => b.text), createdBy: 'user' });
      db.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ? AND status = 'open'").run(draft.id);
      filled = true;
    }
    if (saveFact) {
      db.prepare(`INSERT INTO facts (id, business_id, key, value, source) VALUES (?, ?, ?, ?, 'line_answer')
        ON CONFLICT (business_id, key) DO UPDATE SET value = excluded.value, source = 'line_answer', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .run(newId(), businessId, factKey || q.blank, text);
    }
    store.audit(userId, 'owner_answer', id);
  })();
  return { ok: true, filled };
}
