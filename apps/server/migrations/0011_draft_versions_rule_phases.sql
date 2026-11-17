-- Draft versions: what produced each one (短く / 丁寧に / free instruction / 手直し), so the history is readable.
ALTER TABLE drafts ADD COLUMN note TEXT;
-- Rules by phase of the relationship: first reply, sample, quote/contract, ongoing client, after delivery. NULL = always.
ALTER TABLE playbook_rules ADD COLUMN phase TEXT CHECK (phase IS NULL OR phase IN ('first','sample','deal','active','after'));
