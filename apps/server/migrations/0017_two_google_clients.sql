-- Two Google OAuth clients. 'internal' = the first Google Cloud project (Workspace-internal: only
-- @example.com accounts, tokens never expire). 'external' = the second project that outside
-- businesses use (Testing until Google verification + CASA; Testing refresh tokens last 7 days).
-- Each mailbox remembers which client issued its token: a token refreshes only with its own client.
ALTER TABLE mailboxes ADD COLUMN oauth_client TEXT NOT NULL DEFAULT 'internal' CHECK (oauth_client IN ('internal','external'));
ALTER TABLE businesses ADD COLUMN oauth_client TEXT NOT NULL DEFAULT 'internal' CHECK (oauth_client IN ('internal','external'));
ALTER TABLE oauth_states ADD COLUMN oauth_client TEXT NOT NULL DEFAULT 'internal';
