-- Rules that come from an outside playbook (the Tobira outreach playbook) carry a stable key,
-- e.g. 'tobira-playbook:F2', so a re-sync updates them in place instead of adding copies.
-- Owner-written and AI-proposed rules keep external_key NULL and are never touched by a sync.
ALTER TABLE playbook_rules ADD COLUMN external_key TEXT;
CREATE UNIQUE INDEX playbook_rules_external_key ON playbook_rules (business_id, external_key) WHERE external_key IS NOT NULL;
