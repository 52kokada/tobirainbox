-- Calendar plan step 13: confirm, confirmation draft and undo. Additive only.
-- suggestions.meeting_id: the meeting whose confirm closed this suggestion, so undoing that confirm
--   (D33) puts exactly these back to 'suggested'.
-- drafts.meeting_id / meeting_purpose: the confirmation (D37) or correction (D33) draft written for a
--   meeting. Step 15 sends the meeting's Google invite when its confirmation draft is delivered (D41, D50).
ALTER TABLE suggestions ADD COLUMN meeting_id TEXT REFERENCES meetings(id);
ALTER TABLE drafts ADD COLUMN meeting_id TEXT REFERENCES meetings(id);
ALTER TABLE drafts ADD COLUMN meeting_purpose TEXT CHECK (meeting_purpose IS NULL OR meeting_purpose IN ('confirm','correction'));
CREATE INDEX drafts_meeting ON drafts (meeting_id);
