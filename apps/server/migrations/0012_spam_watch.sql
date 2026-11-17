-- Customer mail that Gmail put in spam: shown in 要対応 with a marker instead of being missed.
ALTER TABLE threads ADD COLUMN in_spam INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mailboxes ADD COLUMN spam_checked_at TEXT;
