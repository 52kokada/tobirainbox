-- 予約送信 (scheduled send). A scheduled send is an ordinary queued send whose undo window runs to the
-- chosen time, so every send invariant (blanks, live mailbox, partner rights, idempotency) still holds and
-- it can be cancelled or moved until then.
--   scheduled_at      the time the person picked (NULL = an ordinary send with the 5–30 s undo window)
--   after_message_id  the newest message in the thread when it was scheduled; if anything newer arrives
--                     first, delivery holds the reply instead of sending an answer to an old message.
ALTER TABLE sends ADD COLUMN scheduled_at TEXT;
ALTER TABLE sends ADD COLUMN after_message_id TEXT;
CREATE INDEX sends_scheduled ON sends (business_id, status, scheduled_at);
