-- Calendar plan step 14 (D13): a change or cancellation found in mail on a thread with a confirmed meeting
-- shows as a "変更の提案" badge; one click applies it. Additive only.
ALTER TABLE meetings ADD COLUMN pending_change_suggestion_id TEXT REFERENCES suggestions(id);
